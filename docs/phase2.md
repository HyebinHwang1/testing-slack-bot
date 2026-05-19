## 2. Step 2.2 — 루트 파일 생성

### 2.1 `package.json`

```bash
cat > package.json << 'EOF'
{
  "name": "dev-knowledge-bot",
  "version": "1.0.0",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "dev:web": "pnpm --filter web dev",
    "dev:api": "vercel dev",
    "build": "pnpm --filter web build",
    "db:check": "tsx scripts/db-check.ts"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "@types/node": "^20.14.0",
    "dotenv": "^16.4.5"
  }
}
EOF
```

### 2.2 `pnpm-workspace.yaml`

```bash
cat > pnpm-workspace.yaml << 'EOF'
packages:
  - 'web'
EOF
```

`api/` 디렉터리는 Vercel Serverless Function이므로 workspace에 넣지 않고 루트 의존성으로 관리합니다.

### 2.3 `vercel.json`

```bash
cat > vercel.json << 'EOF'
{
  "buildCommand": "pnpm build",
  "outputDirectory": "web/dist",
  "installCommand": "pnpm install --no-frozen-lockfile",
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

rewrites 규칙:

- `/api/*`는 Vercel Serverless Function으로
- 나머지는 모두 `index.html`로 (SPA fallback, TanStack Router 클라이언트 라우팅용)

### 2.4 `.gitignore` 확장

```bash
cat >> .gitignore << 'EOF'

# Local env
.env.local
.env*.local

# Dependencies
node_modules

# Build output
web/dist

# Vercel
.vercel

# OS
.DS_Store
EOF
```

### 2.5 폴더 구조 생성

```bash
mkdir -p api/slack api/qa web scripts
```

### 2.6 검증

```bash
ls -la
```

기대 출력: `package.json`, `pnpm-workspace.yaml`, `vercel.json`, `api/`, `web/`, `scripts/` 디렉터리가 모두 존재.

---

## 3. Step 2.3 — Web 패키지 셋업 (Vite + React + Tailwind)

### 3.1 Vite 프로젝트 생성

```bash
cd web
pnpm create vite . --template react-ts
```

대화형 프롬프트가 나오면:

- `Current directory is not empty. Please choose...` → **Ignore files and continue** 선택

### 3.2 의존성 설치

```bash
pnpm install
pnpm add @tanstack/react-router @tanstack/react-query react-markdown
pnpm add -D tailwindcss @tailwindcss/vite
```

### 3.3 `web/vite.config.ts` 교체

```bash
cat > vite.config.ts << 'EOF'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 }
})
EOF
```

### 3.4 `web/src/index.css` 교체

```bash
cat > src/index.css << 'EOF'
@import "tailwindcss";

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #f8fafc;
  color: #0f172a;
}
EOF
```

### 3.5 `web/src/App.tsx` 임시 교체 (Tailwind 동작 확인용)

```bash
cat > src/App.tsx << 'EOF'
function App() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-slate-900">철수 Q&A</h1>
        <p className="mt-2 text-slate-600">사이트 스캐폴딩 완료. Phase 3에서 목록 페이지를 구현합니다.</p>
      </div>
    </div>
  )
}

export default App
EOF
```

### 3.6 검증

```bash
pnpm dev
```

브라우저에서 http://localhost:5173 접속 → "철수 Q&A" 제목과 안내 문구가 보여야 함.

서버 종료: `Ctrl+C`

### 3.7 루트로 복귀

```bash
cd ..
```

---

## 4. Step 2.4 — API 의존성 설치 (루트)

api/ 디렉터리의 Serverless Function들이 사용할 패키지를 루트에 설치합니다.

```bash
pnpm add -w @anthropic-ai/sdk @slack/web-api postgres
pnpm add -wD @vercel/node
```

설치 후 `package.json`의 `dependencies` / `devDependencies` 섹션에 위 패키지들이 추가되었는지 확인.

---

## 5. Step 2.5 — 환경변수 파일

### 5.1 `.env.local` 템플릿 생성

```bash
cat > .env.local << 'EOF'
# ─────────────────────────────────────────
# Supabase Database
# Supabase Dashboard → Connect → Transaction pooler URI
# 형식: postgresql://postgres.{ref}:{password}@aws-0-{region}.pooler.supabase.com:6543/postgres
# 주의: 비밀번호에 @, # 등 특수문자가 있으면 URL 인코딩 필요 (@ → %40)
# ─────────────────────────────────────────
DATABASE_URL=<여기에 본인 Supabase Transaction Pooler URI>

# ─────────────────────────────────────────
# Anthropic API
# https://console.anthropic.com/settings/keys
# 형식: sk-ant-api03-...
# ─────────────────────────────────────────
ANTHROPIC_API_KEY=<여기에 본인 Anthropic API 키>

# ─────────────────────────────────────────
# Slack
# https://api.slack.com/apps → 본인 앱 → OAuth & Permissions → Bot User OAuth Token (xoxb-...)
# https://api.slack.com/apps → 본인 앱 → Basic Information → App Credentials → Signing Secret
# ─────────────────────────────────────────
SLACK_BOT_TOKEN=<여기에 xoxb- 토큰>
SLACK_SIGNING_SECRET=<여기에 Signing Secret>

# ─────────────────────────────────────────
# Site
# Vercel Dashboard → 본인 프로젝트 → Settings → Domains
# 형식: https://dev-knowledge-bot.vercel.app (실제 production URL)
# ─────────────────────────────────────────
SITE_URL=<여기에 본인 Vercel production URL>
EOF
```

### 5.2 사용자 액션 필요

> **⚠️ Claude Code: 여기서 잠시 멈추세요.**
>
> 사용자가 직접 `.env.local` 파일을 열어서 `<여기에 ...>` 5개 자리를 실제 값으로 채워야 합니다. 다음 단계(DB 검증)는 이 작업이 끝난 뒤 진행합니다.
>
> 사용자에게 다음 안내를 보여주세요:
>
> ```
> 다음 명령어로 .env.local을 열고 5개 값을 채워주세요:
>     code .env.local      (VS Code)
>     또는
>     open -e .env.local   (TextEdit)
>
> 값 5개:
> 1. DATABASE_URL — Supabase Transaction Pooler URI
> 2. ANTHROPIC_API_KEY
> 3. SLACK_BOT_TOKEN
> 4. SLACK_SIGNING_SECRET
> 5. SITE_URL
>
> 채운 뒤 "OK"라고 알려주시면 검증 단계로 진행하겠습니다.
> ```

### 5.3 검증 (값 채운 후)

```bash
grep -c "<여기에" .env.local
```

기대 출력: `0` (모든 placeholder가 교체됨)

`0`이 아니라면 채워지지 않은 항목이 남아있는 것이므로 사용자에게 다시 확인 요청.

---

## 6. Step 2.6 — DB 연결 검증

### 6.1 `scripts/db-check.ts` 생성

```bash
cat > scripts/db-check.ts << 'EOF'
import postgres from 'postgres'
import 'dotenv/config'

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL이 .env.local에 설정되어 있지 않습니다.')
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,    // Supabase Transaction Pooler는 prepared statement 미지원
  ssl: 'require',    // Supabase는 SSL 필수
})

async function main() {
  try {
    const result = await sql<{ id: string; question: string; created_at: Date }[]>`
      SELECT id, question, created_at
      FROM qa_items
      WHERE is_deleted = FALSE
      ORDER BY created_at DESC
      LIMIT 5
    `
    console.log('✅ DB 연결 성공')
    console.log(`📊 qa_items 조회 결과: ${result.length}건`)
    result.forEach((row, i) => {
      console.log(`  ${i + 1}. ${row.question.slice(0, 60)}`)
    })
    if (result.length === 0) {
      console.log('  (더미 데이터가 없습니다. Phase 1.2 마지막 INSERT를 다시 실행하세요.)')
    }
  } catch (err) {
    console.error('❌ DB 연결 실패:', (err as Error).message)
    process.exit(1)
  } finally {
    await sql.end()
  }
}

main()
EOF
```

### 6.2 실행

```bash
pnpm db:check
```

### 6.3 기대 출력

```
✅ DB 연결 성공
📊 qa_items 조회 결과: 1건
  1. 철수가 살아있는지 어떻게 확인하나요?
```

### 6.4 흔한 에러와 해결

| 에러 메시지                          | 원인                                         | 해결                                                                                    |
| ------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `password authentication failed`     | DATABASE_URL의 비밀번호 부분이 잘못됨        | Supabase 대시보드에서 비밀번호 재확인. 특수문자는 URL 인코딩 (`@` → `%40`, `#` → `%23`) |
| `getaddrinfo ENOTFOUND`              | DATABASE_URL의 host 부분 오타                | Supabase 대시보드에서 Connection string 다시 복사                                       |
| `self signed certificate`            | SSL 옵션 누락                                | `db-check.ts`에 `ssl: 'require'` 있는지 확인                                            |
| `prepared statement does not exist`  | Transaction Pooler에 prepared statement 보냄 | `prepare: false` 옵션 있는지 확인                                                       |
| `relation "qa_items" does not exist` | Supabase에 스키마가 적용되지 않음            | Phase 1.2의 CREATE TABLE SQL 다시 실행                                                  |

---

## 7. Step 2.7 — 첫 git push

### 7.1 변경사항 확인

```bash
git status
```

추가된 파일들이 모두 나오는지 확인. `.env.local`은 **나오면 안 됨** (`.gitignore`에 포함됨).

만약 `.env.local`이 git status에 나온다면 즉시 중단하고 `.gitignore`를 점검해야 합니다.

### 7.2 검증 (보안 확인)

```bash
git check-ignore .env.local
```

기대 출력: `.env.local`

이 출력이 안 나오면 `.gitignore`가 작동하지 않는 것. 진행 중단.

### 7.3 커밋 & 푸시

```bash
git add .
git commit -m "Initial monorepo scaffold (Phase 2)"
git push origin main
```

### 7.4 Vercel 빌드 확인

브라우저에서 Vercel 대시보드 → `dev-knowledge-bot` 프로젝트 → **Deployments** 탭에서:

- 새 deployment가 자동으로 시작됨
- 1~2분 후 "Ready" 상태로 전환

### 7.5 Production URL 확인

Vercel production URL 접속 → 로컬에서 본 것과 같은 "철수 Q&A" 페이지가 보여야 함.

---

## 8. 최종 폴더 구조

완료 후 다음과 같은 구조여야 합니다.

```
dev-knowledge-bot/
├── api/
│   ├── slack/                (빈 폴더, Phase 3에서 events.ts, interactivity.ts 추가)
│   └── qa/                   (빈 폴더, Phase 3에서 list.ts, [id].ts 추가)
├── web/
│   ├── node_modules/
│   ├── public/
│   ├── src/
│   │   ├── App.tsx           (임시 페이지)
│   │   ├── main.tsx
│   │   ├── index.css         (Tailwind v4)
│   │   └── ...
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── scripts/
│   └── db-check.ts
├── node_modules/             (루트 의존성)
├── .env.local                (gitignore됨, 실제 값 채워짐)
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── README.md
└── vercel.json
```

---

## 9. 완료 체크리스트

다음을 모두 확인한 뒤 사용자에게 보고하세요.

- [ ] `pnpm db:check` 가 ✅ 메시지와 함께 더미 데이터 1건을 출력
- [ ] `pnpm dev:web` 으로 http://localhost:5173 접속 시 "철수 Q&A" 페이지 표시
- [ ] `git push` 후 Vercel Deployments에 "Ready" 상태 표시
- [ ] Vercel production URL 접속 시 동일한 "철수 Q&A" 페이지 표시
- [ ] `.env.local`이 git에 추적되지 않음 (`git check-ignore .env.local` 확인)

---

## 10. 트러블슈팅 (자주 발생하는 문제)

### 10.1 pnpm 명령이 "command not found"

```bash
npm install -g pnpm
```

또는 Corepack 사용:

```bash
corepack enable
corepack prepare pnpm@9.0.0 --activate
```

### 10.2 Vercel 빌드에서 `pnpm: command not found`

Vercel 대시보드 → 프로젝트 → **Settings** → **General**:

- **Install Command**: `pnpm install --no-frozen-lockfile` 명시
- **Build Command**: `pnpm build`
- **Output Directory**: `web/dist`
- **Node.js Version**: 20.x

### 10.3 Vite dev 서버가 켜지지 않음 (포트 점유)

```bash
lsof -ti:5173 | xargs kill -9
```

### 10.4 Vercel 빌드는 성공했는데 사이트가 404

`vercel.json`의 rewrites 규칙 확인. 특히 `/(.*)` → `/index.html` 규칙이 SPA fallback에 필수.

### 10.5 Vercel 빌드에서 환경변수 관련 에러

이 단계에서는 빌드 자체가 환경변수에 의존하지 않으므로 발생하지 않아야 함.
만약 발생한다면, Vercel 대시보드 → Settings → Environment Variables에서 5개 변수가 등록되어 있는지 재확인.

---

## 11. Phase 2 완료 후 다음 단계

Phase 3로 진행하면 다음을 구현합니다.

1. **Hello World 봇**: `@철수 안녕`에 응답하는 minimal `api/slack/events.ts`
2. **ngrok 연결**: 로컬 dev 서버를 Slack 이벤트 URL과 연결
3. **사이트 목록 페이지**: `/api/qa/list`로 DB의 더미 데이터 표시

Phase 3는 별도 문서로 제공됩니다.

---

## 부록 A. 사용된 주요 패키지 버전

| 패키지                 | 용도             | 최소 버전           |
| ---------------------- | ---------------- | ------------------- |
| Node.js                | 런타임           | 20.x                |
| pnpm                   | 패키지 매니저    | 9.x                 |
| Vite                   | 빌드 도구        | 5.x                 |
| React                  | UI 프레임워크    | 18.x                |
| TypeScript             | 타입 시스템      | 5.5+                |
| @tanstack/react-router | 라우팅           | 1.x                 |
| @tanstack/react-query  | 서버 상태        | 5.x                 |
| tailwindcss            | 스타일링         | 4.x (Vite 플러그인) |
| @anthropic-ai/sdk      | Claude API       | 0.30+               |
| @slack/web-api         | Slack API        | 7.x                 |
| postgres               | DB 드라이버      | 3.4+                |
| @vercel/node           | Vercel 함수 타입 | 3.x                 |
| tsx                    | TS 스크립트 실행 | 4.x                 |
| dotenv                 | env 로드         | 16.x                |

## 부록 B. Claude Code 작업 시 주의사항

- **사용자 확인 없이 `.env.local`을 자동 채우지 말 것**. 민감 정보는 사용자가 직접 입력해야 안전합니다.
- **`git add .env.local` 절대 금지**. .gitignore에 있어도 강제로 추가하지 마세요.
- **`git push --force` 사용 금지**. 의도하지 않은 history 변경 방지.
- 각 Step의 검증 단계에서 실패 시 다음 단계로 진행하지 말고 사용자에게 보고.
- 명령어 실행 결과를 그대로 사용자에게 보여줄 것 (요약하지 말고).
