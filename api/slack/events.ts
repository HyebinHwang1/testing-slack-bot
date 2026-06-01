import type { VercelRequest, VercelResponse } from '@vercel/node'
import { WebClient } from '@slack/web-api'
import Anthropic from '@anthropic-ai/sdk'
import { verifySlackSignature } from '../_lib/slack-verify.js'
import { sql, type Section } from '../_lib/db.js'

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'

// 저장 글(answer) 작성 가이드. 원본: 노션 "철수 글 작성 가이드 (시스템 프롬프트)".
// handleSave의 Q/A 추출 프롬프트에 주입된다.
const TOSS_WRITING_GUIDE = `작성 원칙 (answer 작성 시 반드시 따를 것)
[절차] ① 스레드 성격에 맞는 문서 유형 하나를 정한다 → ② 개요→가치→상세 순으로 구조를 잡는다 → ③ 문장을 짧고 구체적이고 능동적으로 다듬는다.

[1. 문서 유형] 아래 중 하나를 골라 그 필수 요소를 담는다.
- 학습 중심(따라 하며 익힘): 학습 목표, 사전 준비, 단계별 안내(무엇을·왜), 쉬운→어려운 예제, FAQ
- 깊은 이해(원리·배경): 등장 배경·해결 문제, 동작 원리, 대안 비교(장단점), 다이어그램, 실제 사용 사례
- 문제 해결(당장 막힌 문제): 문제 정의, 원인·배경, 단계별 절차, 실행 예제·명령어, 환경별 차이(OS·버전), 해결 원리
- 참조(빠른 검색): 간결한 개요, 구문·파라미터(타입·기본값·필수 여부), 반환값, 예제, 연계 방법, 제한사항

[2. 구조] 한 문서=하나의 목표. 개요를 맨 앞에 둬 "이 글로 무엇을 얻는가"를 첫 줄에 밝힌다. 기능보다 문제 해결 효과(가치)를 먼저, 부수 정보는 뒤로. 기본 개념→상세 순. 제목은 30자 이내·핵심 키워드 포함·평서문.

[3. 문장] 한 문장에 하나의 생각, 짧고 간결하게. "앞서 설명했듯이" 같은 군더더기 제거. 모호한 추상어 대신 구체적 표현·동사로 지시. 같은 개념은 같은 용어로, 약어·외래어는 처음에 풀어 씀. 수동형→능동형, 도구가 아니라 독자(개발자)를 주어로.`

async function getRawBody(req: VercelRequest): Promise<string> {
  if (typeof req.body === 'string') return req.body
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body)
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const rawBody = await getRawBody(req)
  const timestamp = req.headers['x-slack-request-timestamp'] as string
  const signature = req.headers['x-slack-signature'] as string

  const signingSecret = process.env.SLACK_SIGNING_SECRET
  if (!signingSecret) {
    console.error('SLACK_SIGNING_SECRET not set')
    return res.status(500).json({ error: 'Server misconfigured' })
  }

  if (!timestamp || !signature) {
    return res.status(401).json({ error: 'Missing Slack signature headers' })
  }

  const signatureValid = verifySlackSignature(signingSecret, timestamp, rawBody, signature)
  if (!signatureValid) {
    if (process.env.VERCEL_ENV === 'production') {
      return res.status(401).json({ error: 'Invalid signature' })
    }
    console.warn('[dev] Slack signature mismatch — skipping verification (vercel dev body parsing artifact)')
  }

  const body = JSON.parse(rawBody)

  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge })
  }

  if (body.type === 'event_callback') {
    const event = body.event
    await handleEvent(event).catch((err) => {
      console.error('Event handler error:', err)
    })
    return res.status(200).json({ ok: true })
  }

  return res.status(200).json({ ok: true })
}

// ──────────────────────────────────────────────────────────────
// 이벤트 라우팅
// ──────────────────────────────────────────────────────────────

interface SlackEvent {
  type: string
  subtype?: string
  user?: string
  text?: string
  ts?: string
  channel?: string
  thread_ts?: string
  channel_type?: string
  bot_id?: string
}

// 봇 user id 캐시 (멘션/본인 메시지 필터링용)
let botUserIdCache: string | null = null
async function getBotUserId(slack: WebClient): Promise<string | null> {
  if (botUserIdCache) return botUserIdCache
  try {
    const auth = await slack.auth.test()
    botUserIdCache = (auth.user_id as string) ?? null
  } catch (err) {
    console.error('auth.test failed:', err)
  }
  return botUserIdCache
}

async function handleEvent(event: SlackEvent | undefined) {
  if (!event) return
  console.log(
    `[event] type=${event.type} subtype=${event.subtype ?? '-'} ch=${event.channel ?? '-'} thread=${event.thread_ts ? 'Y' : 'N'}`,
  )
  if (event.channel_type === 'im') return

  const slackToken = process.env.SLACK_BOT_TOKEN
  if (!slackToken) {
    console.error('SLACK_BOT_TOKEN not set')
    return
  }
  const slack = new WebClient(slackToken)

  if (event.type === 'app_mention') {
    // 기존 멘션 기반 플로우 (스레드=저장 / 메인=질문)
    if (event.thread_ts) {
      await handleSave(event, slack)
    } else {
      await handleQuestion(event, slack)
    }
    return
  }

  if (event.type === 'message') {
    await handleAutoQuestion(event, slack)
  }
}

// ──────────────────────────────────────────────────────────────
// 자동 질문 — 채널 최상위 메시지를 멘션 없이 감지해 답변 + 담당자 태그
// ──────────────────────────────────────────────────────────────

async function handleAutoQuestion(event: SlackEvent, slack: WebClient) {
  // 1) 필터링 — 봇/시스템 메시지, 스레드 답글, 채널/길이 가드
  if (event.subtype || event.bot_id) return
  if (event.thread_ts) return // 최상위 메시지만 트리거

  const targetChannel = process.env.SLACK_TARGET_CHANNEL_ID
  if (targetChannel && event.channel !== targetChannel) return

  const botUserId = await getBotUserId(slack)
  if (botUserId && event.user === botUserId) return // 본인 메시지
  if (botUserId && (event.text ?? '').includes(`<@${botUserId}>`)) return // 멘션은 app_mention이 처리

  const question = (event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim()
  if (question.length < 5) return // 노이즈 가드

  const channel = event.channel!
  const ts = event.ts!

  const text = await composeReply(question)
  await slack.chat.postMessage({ channel, thread_ts: ts, text })
}

// 섹션 분류 + (섹션 스코프) KB 답변 + 담당자/QA 태그를 합쳐 최종 답글 텍스트 생성 (멘션/자동 공용)
// 분기 기준은 "섹션 매칭 여부"가 아니라 "답할 데이터가 있는가"
async function composeReply(question: string): Promise<string> {
  const sections = await sql<Section[]>`
    SELECT id, name, description, curator_slack_id, curator_name,
           is_deleted, created_at, updated_at
    FROM sections
    WHERE is_deleted = FALSE
  `
  const matched = await classifySection(question, sections)
  const { items, scoped } = await fetchKnowledge(matched?.id ?? null)
  console.log(
    `[reply] section=${matched?.name ?? '(none)'} curator=${matched?.curator_slack_id ?? '-'} items=${items.length} scoped=${scoped}`,
  )

  const header = `❓ *${question}*`

  // 분류 실패 → 전역 KB로 best-effort 답변 + QA 라우팅
  if (!matched) {
    const answer = await generateAnswerFromItems(question, items)
    return `${header}\n\n${answer}\n\n${qaRoutingLine()}`
  }

  // 분류 성공 + 답할 데이터 없음 (섹션 0건 + 전역 폴백도 0건) → 라우팅만
  if (items.length === 0) {
    const tag = matched.curator_slack_id ? curatorLine(matched) : qaRoutingLine()
    return `${header}\n\n아직 이 주제에 저장된 답이 없어요. 스레드에서 답변을 정리한 뒤 \`@철수 저장해줘\`로 저장해 주세요.\n\n${tag}`
  }

  // 분류 성공 + 데이터 있음 → 답변 + 담당자 항상 태그(담당자 있으면)
  const answer = await generateAnswerFromItems(question, items)
  const tail = matched.curator_slack_id ? `\n\n${curatorLine(matched)}` : ''
  return `${header}\n\n${answer}${tail}`
}

// 담당자 안내 라인 (담당자가 등록된 섹션일 때)
function curatorLine(section: Section): string {
  return `👤 자세한 사항은 <@${section.curator_slack_id}> 님께 문의하세요. (담당: ${section.name})`
}

// 답을 못 찾았거나 담당자가 없을 때 QA로 라우팅. SLACK_QA_SLACK_ID 미설정 시 텍스트만.
function qaRoutingLine(): string {
  const tag = qaTag()
  return tag
    ? `🙋 담당을 특정하지 못했어요. ${tag} 님이 확인해 주세요.`
    : '🙋 담당을 특정하지 못했어요. QA에게 문의해 주세요.'
}

// QA 담당자 태그 문자열. U…→<@U…>, S…(유저그룹)→<!subteam^S…>, <…> 형태는 그대로, 미설정→'' + warn.
function qaTag(): string {
  const raw = process.env.SLACK_QA_SLACK_ID?.trim()
  if (!raw) {
    console.warn('SLACK_QA_SLACK_ID not set — QA 태그를 생략합니다.')
    return ''
  }
  if (raw.startsWith('<') && raw.endsWith('>')) return raw
  if (/^S[A-Z0-9]+$/.test(raw)) return `<!subteam^${raw}>`
  return `<@${raw}>`
}

// 등록된 섹션 목록 중 질문이 어느 섹션인지 Claude로 분류 (없으면 null)
async function classifySection(
  question: string,
  sections: Section[],
): Promise<Section | null> {
  if (sections.length === 0) return null

  const sectionList = sections
    .map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`)
    .join('\n')

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 })
  try {
    const completion = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 128,
      messages: [
        {
          role: 'user',
          content: `다음 질문이 어느 섹션에 해당하는지 분류해주세요.

섹션 목록:
${sectionList}

규칙:
- 반드시 JSON 객체 하나만 출력 (다른 텍스트 없이)
- 형식: {"section": "<섹션 이름 또는 null>"}
- 목록의 섹션 이름과 정확히 일치하는 값만 사용
- 명확히 해당하는 섹션이 없으면 {"section": null}

질문: ${question}`,
        },
      ],
    })
    const rawText = completion.content[0]?.type === 'text' ? completion.content[0].text : ''
    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const parsed = JSON.parse(jsonMatch[0]) as { section?: string | null }
    if (!parsed.section) return null
    return sections.find((s) => s.name === parsed.section) ?? null
  } catch (err) {
    console.error('classifySection error:', err)
    return null
  }
}

// ──────────────────────────────────────────────────────────────
// 저장 — 스레드 내용을 Claude로 정제해 DB INSERT
// ──────────────────────────────────────────────────────────────

async function handleSave(event: SlackEvent, slack: WebClient) {
  const channel = event.channel!
  const threadTs = event.thread_ts!

  // 1) 스레드 메시지 fetch
  const replies = await slack.conversations.replies({ channel, ts: threadTs })
  const messages = (replies.messages ?? [])
    .filter((m) => !m.bot_id && typeof m.text === 'string' && m.text.trim().length > 0)
    .map((m) => {
      // 봇 멘션은 제거 (저장해줘 같은 트리거 텍스트 노이즈 제거)
      const cleanText = (m.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim()
      return `<@${m.user}>: ${cleanText}`
    })
    .filter((line) => line.length > 0)
    .join('\n')

  if (!messages) {
    await slack.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: '저장할 내용이 없어요. 스레드에 질문과 답변이 있어야 해요.',
    })
    return
  }

  // 2) Claude로 Q/A 추출
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 })
  let rawText = ''
  try {
    const completion = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content:
            `다음 Slack 스레드에서 핵심 질문과 답변을 한 쌍 추출해주세요.\n` +
            `답변은 가독성 좋은 한국어 마크다운으로 정리하세요. 코드/명령어가 있으면 코드 블록으로.\n` +
            (TOSS_WRITING_GUIDE ? `\n${TOSS_WRITING_GUIDE}\n` : '') +
            `\n규칙:\n` +
            `- 반드시 JSON 객체 하나만 출력 (다른 텍스트 없이)\n` +
            `- 형식: {"question": "...", "answer": "..."}\n` +
            `- question은 1문장 이내\n` +
            `- answer는 markdown\n` +
            `\n스레드:\n${messages}`,
        },
      ],
    })
    rawText = completion.content[0]?.type === 'text' ? completion.content[0].text : ''
  } catch (err) {
    const status = (err as { status?: number })?.status
    const msg = status === 529 || status === 503
      ? '⏳ AI 서버가 잠시 혼잡합니다. 잠시 후 다시 `@철수 저장해줘` 해주세요.'
      : status === 429
        ? '⏳ 잠시 후 다시 시도해주세요 (rate limit).'
        : '⚠️ AI 호출 중 오류가 발생했어요.'
    console.error('Claude API error in handleSave:', err)
    await slack.chat.postMessage({ channel, thread_ts: threadTs, text: msg })
    return
  }
  const jsonMatch = rawText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    console.error('Claude response not JSON:', rawText)
    await slack.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: '⚠️ 저장 실패: AI 응답 파싱 오류',
    })
    return
  }

  let qa: { question: string; answer: string }
  try {
    qa = JSON.parse(jsonMatch[0])
  } catch {
    await slack.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: '⚠️ 저장 실패: AI 응답 JSON 파싱 오류',
    })
    return
  }

  if (!qa.question || !qa.answer) {
    await slack.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: '⚠️ 저장 실패: 추출된 Q/A가 비어있어요',
    })
    return
  }

  // 2.5) 섹션 분류 — 셀프-그로잉: 다음 질문이 섹션 스코프로 검색되도록 section_id 채움
  const sectionsForSave = await sql<Section[]>`
    SELECT id, name, description, curator_slack_id, curator_name,
           is_deleted, created_at, updated_at
    FROM sections
    WHERE is_deleted = FALSE
  `
  const savedSection = await classifySection(qa.question, sectionsForSave)
  console.log(`[save] section=${savedSection?.name ?? '(none)'}`)

  // 3) DB INSERT
  const userId = event.user ?? 'UNKNOWN'
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO qa_items (question, answer, author_slack_id, curator_slack_id, section_id)
    VALUES (${qa.question}, ${qa.answer}, ${userId}, ${userId}, ${savedSection?.id ?? null})
    RETURNING id
  `

  // 4) 답글 (저장 커맨드 입력자 태깅)
  const siteUrl = process.env.SITE_URL ?? 'http://localhost:5173'
  await slack.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text:
      `💾 *저장 완료!* (저장: <@${userId}>)\n` +
      `*Q.* ${qa.question}\n` +
      `*A.* ${qa.answer}\n\n` +
      `🔗 ${siteUrl} (id: ${inserted[0]?.id?.slice(0, 8)})`,
  })
}

// ──────────────────────────────────────────────────────────────
// 질문 — DB의 Q&A를 Claude 컨텍스트로 답변
// ──────────────────────────────────────────────────────────────

async function handleQuestion(event: SlackEvent, slack: WebClient) {
  const channel = event.channel!
  const ts = event.ts!
  const question = (event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim()

  if (!question) {
    await slack.chat.postMessage({
      channel,
      thread_ts: ts,
      text: '질문을 입력해주세요. 예) `@철수 supabase 비밀번호 인코딩은 어떻게 해?`',
    })
    return
  }

  const text = await composeReply(question)

  await slack.chat.postMessage({
    channel,
    thread_ts: ts,
    text,
  })
}

type KnowledgeRow = { question: string; answer: string }

// 섹션 우선 조회 → 비면 전역 최근 50건으로 폴백 (전역 LIMIT 50 부담 완화 장치).
// 섹션 스코프 쿼리엔 LIMIT 없음 — 큐레이션된 섹션은 규모가 한정적이라고 가정 (비대해지면 추후 LIMIT 추가).
async function fetchKnowledge(
  sectionId: string | null,
): Promise<{ items: KnowledgeRow[]; scoped: boolean }> {
  if (sectionId) {
    const scopedItems = await sql<KnowledgeRow[]>`
      SELECT question, answer
      FROM qa_items
      WHERE is_deleted = FALSE AND section_id = ${sectionId}
      ORDER BY created_at DESC
    `
    if (scopedItems.length > 0) return { items: scopedItems, scoped: true }
  }
  const globalItems = await sql<KnowledgeRow[]>`
    SELECT question, answer
    FROM qa_items
    WHERE is_deleted = FALSE
    ORDER BY created_at DESC
    LIMIT 50
  `
  return { items: globalItems, scoped: false }
}

// 주어진 KB 항목들을 Claude 컨텍스트로 답변 생성 (검색은 fetchKnowledge가 담당)
async function generateAnswerFromItems(
  question: string,
  items: KnowledgeRow[],
): Promise<string> {
  const knowledgeBase = items
    .map((i, idx) => `[${idx + 1}] Q: ${i.question}\nA: ${i.answer}`)
    .join('\n\n')

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 })
  try {
    const completion = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system:
        '당신은 개발팀 지식 봇 "철수"입니다. 아래 Q&A 데이터베이스를 참고해 사용자 질문에 한국어로 친절하게 답하세요. ' +
        '데이터베이스에 관련 내용이 없으면 솔직하게 "아직 저장된 답이 없어요. 스레드에서 답변을 정리한 뒤 `@철수 저장해줘`로 저장해 주세요."라고 답하세요. ' +
        '답변은 markdown으로, 코드/명령어는 코드 블록으로.',
      messages: [
        {
          role: 'user',
          content: `Q&A 데이터베이스:
${knowledgeBase || '(아직 저장된 항목 없음)'}

사용자 질문: ${question}`,
        },
      ],
    })
    return completion.content[0]?.type === 'text'
      ? completion.content[0].text
      : '답변 생성에 실패했어요.'
  } catch (err) {
    const status = (err as { status?: number })?.status
    if (status === 529 || status === 503) {
      return '⏳ AI 서버가 잠시 혼잡합니다. 잠시 후 다시 시도해 주세요.'
    } else if (status === 429) {
      return '⏳ 잠시 후 다시 시도해주세요 (rate limit).'
    } else {
      console.error('Claude API error:', err)
      return '⚠️ 답변 생성 중 오류가 발생했어요.'
    }
  }
}
