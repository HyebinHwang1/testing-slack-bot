import type { VercelRequest, VercelResponse } from '@vercel/node'
import { WebClient } from '@slack/web-api'
import { verifySlackSignature } from '../_lib/slack-verify.js'

/**
 * vercel dev가 body를 자동 파싱해 stream이 비어있는 케이스를 우회:
 * - req.body가 객체면 JSON.stringify로 raw 재구성 (키 순서 보존)
 * - req.body가 string이면 그대로 사용
 * - 둘 다 없으면 stream에서 직접 읽기 (production fallback)
 */
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

  // vercel dev는 body 자동 파싱 때문에 raw 재구성 시 원본과 byte 차이가 날 수 있음.
  // production에서는 raw가 정확히 도착하므로 검증 정상 작동.
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
    // Vercel 서버리스는 response 후 함수가 빨리 종료될 수 있으므로 먼저 await 후 응답.
    await handleEvent(event).catch((err) => {
      console.error('Event handler error:', err)
    })
    return res.status(200).json({ ok: true })
  }

  return res.status(200).json({ ok: true })
}

// ──────────────────────────────────────────────────────────────
// 이벤트 핸들러
// ──────────────────────────────────────────────────────────────

interface SlackEvent {
  type: string
  user?: string
  text?: string
  ts?: string
  channel?: string
  thread_ts?: string
  channel_type?: string
}

async function handleEvent(event: SlackEvent | undefined) {
  if (!event) return
  // app_mention은 채널 메인/스레드 안 모두에서 발생. thread_ts 유무로 의도 분기.
  // message.channels 이벤트는 중복 응답을 피하기 위해 무시.
  if (event.type !== 'app_mention') return

  if (event.channel_type === 'im') {
    await postEphemeral(event.channel!, event.user!, '철수는 채널에서만 만날 수 있어요.')
    return
  }

  const isInThread = Boolean(event.thread_ts)
  const label = isInThread
    ? '💾 *저장 의도*로 받았어요 (Phase 4에서 스레드 정제 → 모달 저장 구현 예정)'
    : '❓ *질문 의도*로 받았어요 (Phase 4에서 Claude로 답변 생성 예정)'

  const slackToken = process.env.SLACK_BOT_TOKEN
  if (!slackToken) {
    console.error('SLACK_BOT_TOKEN not set')
    return
  }

  const slack = new WebClient(slackToken)

  await slack.chat.postMessage({
    channel: event.channel!,
    thread_ts: event.thread_ts ?? event.ts,
    text: `안녕하세요! <@${event.user}>\n${label}`,
  })
}

async function postEphemeral(channel: string, user: string, text: string) {
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN!)
  await slack.chat.postEphemeral({ channel, user, text })
}
