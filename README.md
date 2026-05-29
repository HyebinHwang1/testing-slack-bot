# testing-slack-bot (houston)

개발팀 지식 봇 "철수" PoC. Slack에서 Q&A를 저장/검색하고, 사업부 문의를 자동 분류해 담당자를 안내한다.

## 기능

- **멘션 기반** (`@철수`)
  - 스레드에서 멘션 → 스레드 내용을 Claude로 정제해 Q&A 저장
  - 채널에서 멘션 → 저장된 지식베이스(KB)로 답변
- **자동 감지** (멘션 불필요) — 대상 채널의 최상위 메시지를 감지해:
  1. 질문이 어느 **섹션**인지 분류
  2. 기존 KB로 **답변 제공**
  3. 해당 섹션에 **담당자가 등록돼 있으면 답글에 `@태그`**해 "자세한 건 담당자에게 문의" 안내
- **어드민** (`/#/admin/sections`) — 섹션(이름·설명·담당자 Slack ID) CRUD

## 셋업

### 1. 환경변수 (`.env.local`)

```
DATABASE_URL=...              # Supabase Postgres
ANTHROPIC_API_KEY=sk-ant-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SITE_URL=http://localhost:5173
SLACK_TARGET_CHANNEL_ID=C...  # (선택) 자동 감지를 이 채널로만 제한. 미설정 시 봇이 속한 모든 채널
```

### 2. DB

Supabase SQL Editor에서 `scripts/sections-schema.sql` 1회 실행 → 연결 확인:

```bash
pnpm db:check
```

### 3. Slack 앱 콘솔 설정 (자동 감지용)

- **OAuth & Permissions** → Bot Token Scopes에 `channels:history` 추가 (재설치 필요)
- **Event Subscriptions** → Subscribe to bot events에 `message.channels` 추가
- 봇을 대상 채널에 초대 (`/invite @철수`)

> 멘션(`app_mention`)만 쓰던 기존 설정에 위 두 가지가 추가됐다. 자동 감지를 켜지 않으려면 `message.channels` 구독을 빼면 된다.

### 4. 실행

```bash
pnpm install
pnpm dev:api    # vercel dev (api/*, localhost:5001) — .env.local을 셸에 source 후 기동
pnpm dev:web    # vite (web, localhost:5173) — /api/* 는 5001로 프록시
```

> `vercel dev`는 `.env.local`을 함수 환경에 자동 주입하지 않으므로, `dev:api` 스크립트가 실행 전에 `.env.local`을 `source` 한다. `.env.local` 값을 바꾸면 `dev:api`를 재시작해야 반영된다.

로컬에서 Slack 이벤트를 받으려면 ngrok 등으로 `https://<tunnel>/api/slack/events`를 Event URL에 등록한다.

## 동작 메모

- 자동 감지는 **최상위 메시지만** 트리거한다 (스레드 답글·봇 메시지·시스템 메시지·5자 미만·봇 멘션 메시지는 무시 — 멘션은 `app_mention`이 처리하므로 중복 없음).
- 섹션은 **담당자 매칭용 분류**일 뿐, 답변은 항상 전체 KB(`qa_items`)에서 생성한다.
