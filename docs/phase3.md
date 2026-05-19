# Phase 3: Hello World 연결 가이드

> 이 문서는 Claude Code 또는 개발자가 그대로 따라 실행할 수 있도록 작성되었습니다.
> Phase 2가 완료된 상태에서 시작합니다.

---

## 0. 개요

### 0.1 목표

Phase 2의 빈 스캐폴딩 위에 **인프라 연결을 검증하는 Hello World**를 구현합니다. Phase 3가 끝나면 다음 두 가지가 동작해야 합니다.

1. **Slack**: 채널에서 `@철수 안녕`을 입력하면 봇이 응답하고, 봇 응답에 의도 분기 라벨이 표시됨
   - 스레드 밖 멘션 → "질문 의도로 받았어요" 라벨
   - 스레드 안 멘션 → "저장 의도로 받았어요" 라벨
2. **사이트**: Vercel production URL 접속 시 DB의 더미 Q&A 1건이 목록으로 표시됨

### 0.2 Phase 3에서 다루지 않는 것 (Phase 4 / AI Day 본 시간으로)

- 실제 Claude API 호출 (`@철수`가 진짜 질문에 답하는 기능)
- 스레드 정제 → 모달 → DB 저장
- Q&A 상세 페이지
- pg_trgm 검색
- GitHub repo 동기화

Phase 3는 **모든 인프라 토큰·URL·이벤트 흐름이 정상 동작하는지 검증**이 본 목적입니다.

### 0.3 전제조건

Phase 2 완료 체크리스트가 모두 통과한 상태:

- [x] `pnpm db:check` 성공 (더미 데이터 1건 출력)
- [x] `pnpm dev:web` 으로 localhost:5173에서 임시 페이지 표시
- [x] `git push` 후 Vercel 빌드 성공 및 production URL 동일 페이지 표시
- [x] `.env.local`에 5개 값 모두 채워짐

### 0.4 진행 방식 안내 (Claude Code용)

- 각 Step은 한 단계씩 끊어서 실행
- 코드 작성 후 반드시 검증 단계 통과 확인
- ngrok / Slack 콘솔 / Vercel 콘솔 작업은 사용자에게 명시적으로 안내하고 멈춤
- 환경변수가 필요한 곳에서 값이 비어있으면 진행 중단

---

## 1. Step 3.1 — ngrok 설치 및 계정 연결

### 1.1 설치 확인

```bash
ngrok version
```

이미 설치되어 있다고 했으므로 버전이 출력되어야 함. 안 나오면:

```bash
brew install ngrok
```

### 1.2 ngrok 계정 가입 + authtoken 등록

1. https://ngrok.com 접속 → 가입 (GitHub 로그인 가능)
2. 대시보드 → **Your Authtoken** 페이지에서 토큰 복사
3. 로컬에서 등록:

```bash
ngrok config add-authtoken <복사한 토큰>
```

> **⚠️ Claude Code: 여기서 사용자에게 ngrok 가입 + authtoken 등록 안내 후 멈추세요.**
> 사용자가 "OK"라고 답할 때까지 다음 단계로 진행하지 마세요.

### 1.3 검증

```bash
ngrok config check
```

기대 출력: `Valid configuration file at ...`

---

## 2. Step 3.2 — Slack 서명 검증 유틸리티

Slack은 모든 요청에 `x-slack-signature` 헤더를 붙입니다. 봇 엔드포인트는 이 서명을 검증해야 보안상 안전합니다. (검증 안 하면 누구나 가짜 요청 보낼 수 있음)

### 2.1 `api/_lib/` 디렉터리 생성

```bash
mkdir -p api/_lib
```

밑줄(`_`) 접두사: Vercel은 `_`로 시작하는 디렉터리·파일을 함수 라우트로 노출하지 않음. 공유 유틸용.

### 2.2 `api/_lib/slack-verify.ts` 생성

```bash
cat > api/_lib/slack-verify.ts << 'EOF'
import crypto from 'node:crypto'

/**
 * Slack 요청 서명 검증.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  // 5분 이상 지난 요청은 reject (replay attack 방지)
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - Number(timestamp)) > 60 * 5) {
    return false
  }

  const baseString = `v0:${timestamp}:${rawBody}`
  const hmac = crypto.createHmac('sha256', signingSecret)
  hmac.update(baseString)
  const expected = `v0=${hmac.digest('hex')}`

  // timing-safe 비교
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
EOF
```

---

## 3. Step 3.3 — Slack Events 핸들러 (Hello World)

### 3.1 `api/slack/events.ts` 생성

```bash
cat > api/slack/events.ts << 'EOF'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { WebClient } from '@slack/web-api'
import { verifySlackSignature } from '../_lib/slack-verify.js'

/**
 * Vercel은 기본적으로 body를 JSON 파싱하지만,
 * Slack 서명 검증은 raw body가 필요하므로 비활성화.
 */
export const config = {
  api: {
    bodyParser: false,
  },
}

async function readRawBody(req: VercelRequest): Promise<string> {
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

  const rawBody = await readRawBody(req)
  const timestamp = req.headers['x-slack-request-timestamp'] as string
  const signature = req.headers['x-slack-signature'] as string

  // 서명 검증
  const signingSecret = process.env.SLACK_SIGNING_SECRET
  if (!signingSecret) {
    console.error('SLACK_SIGNING_SECRET not set')
    return res.status(500).json({ error: 'Server misconfigured' })
  }

  if (!timestamp || !signature) {
    return res.status(401).json({ error: 'Missing Slack signature headers' })
  }

  if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' })
  }

  const body = JSON.parse(rawBody)

  // Slack Event Subscription URL 검증 (최초 1회)
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge })
  }

  // 실제 이벤트 처리
  if (body.type === 'event_callback') {
    const event = body.event

    // Slack에 3초 안에 200을 반환하지 않으면 재전송하므로,
    // 비동기 처리를 시작하기 전 즉시 200 응답.
    res.status(200).json({ ok: true })

    // 이후 비동기 처리
    await handleEvent(event).catch((err) => {
      console.error('Event handler error:', err)
    })
    return
  }

  return res.status(200).json({ ok: true })
}

// ──────────────────────────────────────────────────────────────
// 이벤트 핸들러
// ──────────────────────────────────────────────────────────────

interface AppMentionEvent {
  type: 'app_mention'
  user: string
  text: string
  ts: string
  channel: string
  thread_ts?: string       // 스레드 안 멘션이면 채워짐
  channel_type?: string    // im, channel, group 등
}

async function handleEvent(event: AppMentionEvent | { type: string }) {
  if (event.type !== 'app_mention') return

  const e = event as AppMentionEvent

  // DM 차단 (channel_type === 'im')
  // app_mention 이벤트는 보통 DM에서 발생하지 않지만 안전장치
  if (e.channel_type === 'im') {
    await postEphemeral(e.channel, e.user, '철수는 채널에서만 만날 수 있어요.')
    return
  }

  // 위치 기반 의도 분기
  const isInThread = Boolean(e.thread_ts)
  const label = isInThread
    ? '💾 *저장 의도*로 받았어요 (Phase 4에서 스레드 정제 → 모달 저장 구현 예정)'
    : '❓ *질문 의도*로 받았어요 (Phase 4에서 Claude로 답변 생성 예정)'

  const slackToken = process.env.SLACK_BOT_TOKEN
  if (!slackToken) {
    console.error('SLACK_BOT_TOKEN not set')
    return
  }

  const slack = new WebClient(slackToken)

  // 스레드 안에서 멘션됐으면 같은 스레드에 답글, 아니면 새 스레드 시작
  await slack.chat.postMessage({
    channel: e.channel,
    thread_ts: e.thread_ts ?? e.ts,
    text: `안녕하세요! <@${e.user}>\n${label}`,
  })
}

async function postEphemeral(channel: string, user: string, text: string) {
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN!)
  await slack.chat.postEphemeral({ channel, user, text })
}
EOF
```

### 3.2 TypeScript 컴파일 확인

```bash
npx tsc --noEmit api/slack/events.ts api/_lib/slack-verify.ts
```

에러 없이 끝나야 함. 만약 타입 에러가 나면 사용자에게 보고하고 진행 중단.

---

## 4. Step 3.4 — 로컬 dev 서버 + ngrok 띄우기

### 4.1 Vercel CLI 설치 확인

```bash
vercel --version
```

없으면:

```bash
pnpm add -g vercel
```

### 4.2 Vercel 프로젝트 link (최초 1회)

루트 디렉터리에서:

```bash
vercel link
```

대화형 프롬프트:

- `Set up "..."?` → **Y**
- `Which scope should contain your project?` → 본인 계정 선택
- `Link to existing project?` → **Y**
- `What's the name of your existing project?` → `dev-knowledge-bot`

성공하면 `.vercel/` 디렉터리가 생기고 link 완료.

### 4.3 환경변수 로컬 동기화

Vercel에 등록한 환경변수를 로컬 `vercel dev`에서도 쓸 수 있게 가져옴:

```bash
vercel env pull .env.local
```

> **⚠️ 주의**: 이 명령은 기존 `.env.local`을 덮어씁니다. Phase 2에서 직접 채운 값과 Vercel에 등록한 값이 같다면 문제없음. 다르다면 사용자에게 어느 쪽이 정답인지 확인.

검증:

```bash
grep -c "^[A-Z_]*=." .env.local
```

기대 출력: `5` (DATABASE_URL, ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SITE_URL)

### 4.4 dev 서버 띄우기 (터미널 #1)

```bash
pnpm dev:api
```

기대 출력:

```
Vercel CLI
> Ready! Available at http://localhost:3000
```

`localhost:3000`이 봇 엔드포인트.

### 4.5 ngrok 띄우기 (터미널 #2 — 새 터미널 창)

```bash
ngrok http 3000
```

기대 출력:

```
Session Status     online
Forwarding         https://abc123.ngrok-free.app -> http://localhost:3000
```

**`https://`로 시작하는 ngrok URL을 메모.** 다음 단계에서 Slack에 등록할 거예요.

> **⚠️ Claude Code: 두 터미널은 계속 실행 상태로 둬야 합니다.**
> 이 시점에서 사용자에게 ngrok URL을 알려달라고 요청하고 멈춥니다.

---

## 5. Step 3.5 — Slack Event Subscription URL 등록

### 5.1 Slack 앱 콘솔에서 등록

1. https://api.slack.com/apps → 본인 앱(`철수`) 클릭
2. 좌측 사이드바 **Event Subscriptions** 클릭
3. **Enable Events**가 ON인지 확인 (manifest로 만들었으면 자동 ON)
4. **Request URL** 입력란에 다음 URL 입력:

   ```
   https://abc123.ngrok-free.app/api/slack/events
   ```

   (`abc123` 부분은 본인 ngrok URL로 교체)

5. URL 입력 후 잠시 대기 → **Verified ✓** 표시가 나와야 함

> **검증 실패 시 점검**:
>
> - 터미널 #1의 `vercel dev`가 켜져 있는가
> - 터미널 #2의 ngrok이 켜져 있는가
> - ngrok URL이 정확한가 (`/api/slack/events` 경로 포함)
> - `vercel dev` 로그에 요청이 도착하는가 (안 도착하면 ngrok 문제)
> - `vercel dev` 로그에 401 Invalid signature가 뜨는가 (SIGNING_SECRET 불일치)

### 5.2 Subscribe to bot events 확인

같은 페이지 아래쪽 **Subscribe to bot events** 섹션에 다음 이벤트가 등록되어 있는지 확인:

- `app_mention`
- `message.channels`
- `message.groups`

manifest로 만들었으면 자동 등록되어 있음. 없으면 **Add Bot User Event**로 추가.

### 5.3 변경사항 저장

페이지 하단 **Save Changes** 클릭. 워크스페이스 재설치 요청이 뜨면 **Reinstall app** → **Allow**.

> **⚠️ Claude Code: 사용자에게 위 작업 완료 후 "OK"를 답해달라고 요청하고 멈춥니다.**

---

## 6. Step 3.6 — Slack에서 봇 테스트

### 6.1 봇을 채널에 초대

1. 테스트 워크스페이스 Slack 클라이언트 접속
2. 테스트용 채널(예: `#general`) 열기 (없으면 새로 생성)
3. 메시지 입력란에 `/invite @철수` (또는 영문 username으로 등록한 이름) 입력
4. 채널에 봇이 추가되었다는 메시지 확인

### 6.2 스레드 밖 멘션 테스트

채널 메인에 입력:

```
@철수 안녕
```

기대 결과: 봇이 채널에 답글로 다음과 같이 응답

```
안녕하세요! @{본인}
❓ 질문 의도로 받았어요 (Phase 4에서 Claude로 답변 생성 예정)
```

### 6.3 스레드 안 멘션 테스트

1. 아무 메시지의 답글(스레드)을 열기
2. 스레드 안에서 입력:

```
@철수 이거 저장해줘
```

기대 결과: 봇이 같은 스레드에 답글로 다음과 같이 응답

```
안녕하세요! @{본인}
💾 저장 의도로 받았어요 (Phase 4에서 스레드 정제 → 모달 저장 구현 예정)
```

### 6.4 문제 발생 시 점검 순서

1. `vercel dev` 로그에 요청이 도착하는가?
   - 안 도착 → Slack Event URL 잘못됐거나 ngrok 죽음
2. 도착했는데 401 응답이 나가는가?
   - → `SLACK_SIGNING_SECRET` 값 점검. Slack 콘솔 Basic Information의 Signing Secret과 일치하는지
3. 200 응답인데 봇이 메시지를 안 보내는가?
   - → `vercel dev` 로그에서 "Event handler error" 확인. 보통 `SLACK_BOT_TOKEN` 문제
4. 봇이 채널에 없다고 에러가 나는가?
   - → 봇을 채널에 초대 안 한 것. `/invite @철수`

> **⚠️ Claude Code: 사용자가 두 가지 테스트(6.2, 6.3) 모두 성공했다고 확인할 때까지 다음으로 진행하지 마세요.**

---

## 7. Step 3.7 — 사이트 목록 API + UI

이제 사이트 쪽. 두 가지를 만듭니다.

1. `GET /api/qa/list` — DB에서 Q&A 목록 반환
2. 사이트 목록 페이지 — API 호출 후 표시

### 7.1 `api/_lib/db.ts` 생성 (DB 클라이언트 공유)

```bash
cat > api/_lib/db.ts << 'EOF'
import postgres from 'postgres'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL not set')
}

export const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: 'require',
})

export interface QaItem {
  id: string
  question: string
  answer: string
  author_slack_id: string
  curator_slack_id: string
  view_count: number
  created_at: Date
  updated_at: Date
}
EOF
```

### 7.2 `api/qa/list.ts` 생성

```bash
cat > api/qa/list.ts << 'EOF'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql, type QaItem } from '../_lib/db.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const items = await sql<QaItem[]>`
      SELECT id, question, answer, author_slack_id, curator_slack_id,
             view_count, created_at, updated_at
      FROM qa_items
      WHERE is_deleted = FALSE
      ORDER BY created_at DESC
      LIMIT 100
    `
    return res.status(200).json({ items })
  } catch (err) {
    console.error('GET /api/qa/list error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
EOF
```

### 7.3 로컬 API 테스트

`vercel dev`가 켜진 상태에서 (없으면 `pnpm dev:api` 다시 실행) 별도 터미널에서:

```bash
curl http://localhost:3000/api/qa/list
```

기대 출력 (JSON):

```json
{
  "items": [
    {
      "id": "...",
      "question": "철수가 살아있는지 어떻게 확인하나요?",
      "answer": "# 동작 확인\n\n사이트에 이 항목이 보이면 DB 연결이 정상입니다. ✅",
      ...
    }
  ]
}
```

### 7.4 사이트 목록 페이지

`web/src/App.tsx` 교체:

```bash
cat > web/src/App.tsx << 'EOF'
import { useEffect, useState } from 'react'

interface QaItem {
  id: string
  question: string
  answer: string
  author_slack_id: string
  curator_slack_id: string
  view_count: number
  created_at: string
  updated_at: string
}

function App() {
  const [items, setItems] = useState<QaItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/qa/list')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: { items: QaItem[] }) => {
        setItems(data.items)
        setLoading(false)
      })
      .catch((err: Error) => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <h1 className="text-2xl font-bold text-slate-900">철수 Q&A</h1>
          <p className="mt-1 text-sm text-slate-500">개발팀 지식 저장소</p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8">
        {loading && (
          <div className="text-slate-500">불러오는 중...</div>
        )}

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
            오류: {error}
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div className="text-slate-500">아직 저장된 Q&A가 없어요.</div>
        )}

        {!loading && !error && items.length > 0 && (
          <ul className="space-y-3">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-lg bg-white border border-slate-200 p-4 hover:border-slate-300 transition-colors"
              >
                <div className="font-medium text-slate-900">{item.question}</div>
                <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
                  <span>작성: {item.author_slack_id}</span>
                  <span>·</span>
                  <span>조회 {item.view_count}회</span>
                  <span>·</span>
                  <span>{new Date(item.created_at).toLocaleDateString('ko-KR')}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

export default App
EOF
```

### 7.5 로컬에서 사이트 확인

새 터미널 (#3)에서:

```bash
pnpm dev:web
```

http://localhost:5173 접속.

> **잠깐**: localhost:5173는 Vite dev 서버라 `/api/*` 요청을 어디로 보낼지 모릅니다. Vite 프록시 설정 필요.

### 7.6 Vite 프록시 설정 (로컬 dev 환경에서 API 호출용)

`web/vite.config.ts` 교체:

```bash
cat > web/vite.config.ts << 'EOF'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
EOF
```

`/api/*` 요청이 자동으로 `localhost:3000` (vercel dev)로 프록시됨.

### 7.7 사이트 검증

`pnpm dev:web`을 다시 실행해서 http://localhost:5173 접속.

기대 화면:

- 상단에 "철수 Q&A" 헤더
- "철수가 살아있는지 어떻게 확인하나요?" 카드 1개 표시
- 작성자(`U_DEMO_AUTHOR`), 조회 0회, 오늘 날짜

표시 안 되는 경우:

- 브라우저 개발자 도구 **Network** 탭에서 `/api/qa/list` 요청 확인
- 401/500 에러면 `vercel dev` 로그 확인
- 404면 프록시 설정 잘못됨

---

## 8. Step 3.8 — git push + Vercel production 배포 검증

### 8.1 변경사항 확인

```bash
git status
```

다음 파일들이 추가/수정되어 있어야 함:

- `api/_lib/slack-verify.ts`
- `api/_lib/db.ts`
- `api/slack/events.ts`
- `api/qa/list.ts`
- `web/src/App.tsx`
- `web/vite.config.ts`

### 8.2 보안 확인

```bash
git check-ignore .env.local
```

`.env.local`이 출력되어야 함. 안 나오면 절대 push 금지.

### 8.3 커밋 & 푸시

```bash
git add .
git commit -m "Phase 3: Slack Hello World + Q&A list API"
git push origin main
```

### 8.4 Vercel 빌드 모니터링

브라우저에서 Vercel 대시보드 → Deployments에서 새 빌드 시작 확인 → 1~2분 후 "Ready".

### 8.5 Production 사이트 검증

Vercel production URL 접속 → 로컬에서 본 것과 동일한 Q&A 목록 페이지가 보여야 함.

> **⚠️ Claude Code: 사용자에게 production URL 접속 후 결과 확인 요청하고 멈춥니다.**

---

## 9. Step 3.9 — Slack URL을 production으로 전환 (선택)

ngrok URL은 무료 플랜에서 매번 바뀝니다. AI Day 데모 직전이나 안정화 시점에 production URL로 바꾸세요.

### 9.1 Slack Event URL 변경

1. https://api.slack.com/apps → 본인 앱 → **Event Subscriptions**
2. **Request URL**을 production URL로 변경:

   ```
   https://dev-knowledge-bot.vercel.app/api/slack/events
   ```

3. **Verified ✓** 확인 → **Save Changes**

### 9.2 Production에서 봇 테스트

ngrok 두 터미널을 모두 닫고, 다시 Slack에서 `@철수 안녕` 테스트.

production이 응답하면 ngrok 없이 동작 확정.

> **운영 팁**: 개발 중에는 ngrok URL, 데모/운영 시에는 production URL. URL 변경 시 마다 Slack 콘솔 변경 필요.

---

## 10. 완료 체크리스트

다음을 모두 확인 후 사용자에게 보고:

- [ ] `ngrok config check`이 Valid 출력
- [ ] `pnpm dev:api`로 로컬 봇 서버 정상 기동
- [ ] `ngrok http 3000`으로 외부 URL 발급
- [ ] Slack Event Subscription URL **Verified ✓**
- [ ] 채널에서 `@철수 안녕` → "❓ 질문 의도로 받았어요" 응답
- [ ] 스레드 안 `@철수 저장해줘` → "💾 저장 의도로 받았어요" 응답
- [ ] `curl localhost:3000/api/qa/list` → 더미 데이터 1건 JSON
- [ ] localhost:5173에서 목록 페이지 정상 표시
- [ ] `git push` 후 Vercel 빌드 성공
- [ ] Production URL에서도 목록 페이지 정상 표시
- [ ] (선택) Slack URL을 production으로 전환 후에도 봇 응답 정상

---

## 11. Phase 3 완료 후 다음

Phase 4 (AI Day 본 시간 4시간)에서 구현할 것:

1. **`@철수` 질문 처리** — pg_trgm 검색 → 없으면 Claude API 호출
2. **스레드 정제 → 모달** — `conversations.replies` fetch → Claude로 Q/A 추출 → Slack Modal 띄우기
3. **저장 완료 알림** — 스레드 답글로 글 링크 + 큐레이터 멘션
4. **답변 출처 라벨링** — AI 생성 / 팀 저장 구분
5. **`/qa-rank` 등 보조 명령** — 기여자 랭킹
6. **사이트 상세 페이지** — `/qa/:id` 라우트 + Markdown 렌더링 (TanStack Router)
7. **GitHub repo 동기화** — DB 변경 시 `.md` 파일 commit (Should)

Phase 4는 별도 시간(AI Day)에 본격 진행. Phase 3까지 끝낸 시점에서 모든 인프라가 검증되었으므로 비즈니스 로직 작성에만 집중 가능.

---

## 12. 트러블슈팅

### 12.1 `vercel dev`가 켜지지 않음

```
Error! Could not find any pages.
```

→ `vercel link`가 먼저 필요. 또는 `api/` 디렉터리 안에 파일이 있는지 확인.

### 12.2 `vercel dev` 시 환경변수 인식 안 됨

→ `vercel env pull .env.local` 다시 실행.

### 12.3 ngrok URL이 매번 바뀌어서 귀찮음

→ 무료 ngrok은 매 실행마다 바뀌는 게 정상. AI Day 데모 직전에 production URL로 전환 (Step 9).
→ 또는 ngrok 유료 ($10/월)로 fixed domain 사용.

### 12.4 Slack URL Verification에서 `Your URL didn't respond with the value of the challenge parameter`

→ `events.ts`의 url_verification 분기가 작동 안 함. JSON 파싱 또는 응답 헤더 문제. `vercel dev` 로그에서 url_verification 요청 확인.

### 12.5 봇이 한 메시지에 두 번 응답

→ Slack은 봇의 응답도 `message.channels` 이벤트로 다시 보냄. 우리 코드는 `app_mention`만 처리하므로 무관. 만약 두 번 응답하면 ngrok 같은 URL을 가진 다른 dev 서버가 동시에 떠 있는 것.

### 12.6 production 배포 후 API 500 에러

→ Vercel Functions 로그 확인 (Deployments → Functions 탭). 가장 흔한 원인은 환경변수 미등록. Settings → Environment Variables에서 5개 다 등록됐는지 재확인.

---

## 부록 A. 주요 파일 변경 요약

Phase 3에서 추가/수정한 파일:

| 파일                       | 역할                              |
| -------------------------- | --------------------------------- |
| `api/_lib/slack-verify.ts` | Slack 서명 검증 함수              |
| `api/_lib/db.ts`           | Supabase Postgres 클라이언트 공유 |
| `api/slack/events.ts`      | Slack 이벤트 핸들러 (Hello World) |
| `api/qa/list.ts`           | Q&A 목록 GET API                  |
| `web/src/App.tsx`          | 목록 페이지 UI                    |
| `web/vite.config.ts`       | API 프록시 추가                   |

## 부록 B. Claude Code 작업 시 주의사항

- **3.4 / 5 / 6 / 8 / 9 단계는 사용자 액션 필수**. 자동 진행 금지.
- 코드 작성 후 `npx tsc --noEmit`으로 타입 체크 권장.
- `vercel dev` 실행 시 자동으로 환경변수 로드. `.env.local`에 값이 있는지 사전 확인.
- Slack 콘솔 작업(Event URL 등록 등)은 코드 작업이 아니므로 사용자에게 명시적으로 위임.
- 봇이 응답 안 하는 문제 디버깅 시 가장 먼저 확인할 곳: `vercel dev` 로그 → ngrok inspector (http://localhost:4040) → Slack 콘솔 Event Subscriptions 페이지.
