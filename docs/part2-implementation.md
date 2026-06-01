# Part 2 구현 — 전시 데이터 셀프-그로잉 Q&A

> 노션 "Part 2 — 전시 데이터 적재 & 답변 품질 테스트" 설계를 코드에 적용한 작업 정리.
> 브랜치: `slackbot-exhibition-data-quality-test`

---

## 0. 무엇을 / 왜

봇 "철수"의 답변을 **섹션 스코프**로 좁히고, 답이 없을 땐 담당자/QA로 라우팅해 답을 받아 저장하는 **셀프-그로잉 루프**를 얹었다.

1. **섹션 스코프 답변** — 기존 `generateAnswer`는 전역 최신 50건(`LIMIT 50`)을 통째로 주입해서 KB가 커지면 오래된 항목이 누락됐다. 이제 *분류된 섹션의 Q&A*만(섹션 내 LIMIT 없음) 컨텍스트로 넣고, 섹션이 비면 전역 50건으로 폴백한다.
2. **셀프-그로잉** — 저장 시 섹션을 분류해 `qa_items.section_id`를 채운다. 담당자가 답 → `@철수 저장해줘` → 해당 섹션에 쌓임 → 다음 질문부터 섹션 스코프로 답변.

분기 기준은 **"섹션 매칭 여부"가 아니라 "답할 데이터가 있는가"** 다.

---

## 1. 변경/생성 파일

| 파일 | 작업 | 내용 |
| --- | --- | --- |
| `scripts/qa-section-id-schema.sql` | 생성 | 멱등 DDL — `section_id UUID` 추가 + FK(`ON DELETE SET NULL`) + 부분 인덱스 |
| `scripts/migrate.ts` | 생성 | 위 DDL을 적용·검증하는 tsx 러너 (`pnpm db:migrate`) |
| `scripts/seed-exhibition.ts` | 생성 | 섹션별 묶음 마크다운 → `section_id` 포함 bulk INSERT (`pnpm seed:exhibition`) |
| `scripts/sample-exhibition.md` | 생성 | seed 형식 예시 / dry-run 시연용 |
| `api/_lib/db.ts` | 수정 | `QaItem`에 `section_id: string \| null` |
| `api/qa/list.ts`, `api/qa/get.ts` | 수정 | SELECT/RETURNING에 `section_id` (타입 정합성) |
| `api/slack/events.ts` | 수정 | 런타임 분기 재구성 + 저장 시 섹션 분류 (아래 §2) |
| `package.json` | 수정 | `db:migrate`, `seed:exhibition` 스크립트 |

범위 밖: `web/src/App.tsx`(자체 인터페이스), `api/sections.ts`.

---

## 2. 런타임 동작 (`api/slack/events.ts`)

### 검색/생성 분리
- `fetchKnowledge(sectionId)` — 섹션 우선 조회(LIMIT 없음), 0건이면 전역 최근 50건 폴백. `{ items, scoped }` 반환.
- `generateAnswerFromItems(question, items)` — 기존 `generateAnswer` 본문에서 SELECT만 제거(items 주입). 시스템 프롬프트·에러 처리 동일. (기존 `generateAnswer`는 삭제)

### `composeReply` 분기 (멘션 질문 / 자동 감지 공용)

| 상황 | 답변 | 꼬리 라인 |
| --- | --- | --- |
| 분류됨 + 섹션에 데이터 있음 | 섹션 스코프 KB로 생성 | 담당자 태그(있으면) |
| 분류됨 + 데이터 없음(폴백도 0) | "아직 …저장해줘" | 담당자 있으면 담당자, 없으면 QA |
| 분류 실패 | 전역 KB로 best-effort 생성 | QA 태그 |

### 저장 루프 (`handleSave`)
- Q/A 추출 후 INSERT 전에 `classifySection(qa.question)` → `section_id` 채움.
- 확인 답글에 저장 커맨드 입력자 태깅: `💾 *저장 완료!* (저장: <@USER>)`.
- `TOSS_WRITING_GUIDE` 상수(현재 `''`) — 토스 라이팅 원칙을 채우면 저장 프롬프트에 주입됨. 비어 있는 동안 동작 불변.

---

## 3. 환경변수

| 변수 | 용도 |
| --- | --- |
| `SLACK_QA_SLACK_ID` | (신규) 담당자가 없거나 분류 실패 시 태그할 QA 담당자. `U…`(유저)·`S…`(유저그룹)·`<…>`(완성형) 지원. **미설정 시 태그 생략 + warn.** |
| `SEED_AUTHOR_SLACK_ID` | (선택) seed 적재 시 author/curator 값. 기본 `SEEDBOT`. |

`.env.local`과 Vercel 환경변수 양쪽에 `SLACK_QA_SLACK_ID`를 등록해야 운영에서 태그가 동작한다.

---

## 4. 검증

### ✅ 완료 (이 작업에서 자동 확인)
- 타입 체크: `npx tsc --noEmit --strict --skipLibCheck --esModuleInterop --module nodenext --moduleResolution nodenext --target es2022 <touched .ts>` → 통과
- seed dry-run: `pnpm seed:exhibition scripts/sample-exhibition.md --dry-run` → 4건/2섹션 파싱 OK
- seed 실패 경로(인자 없음 / 없는 파일) → 명확한 에러

### ⏳ 사용자 확인 필요 (DB·Slack 접속)
1. **마이그레이션** — Supabase SQL Editor에서 `scripts/qa-section-id-schema.sql` 실행. (또는 `.env.local` 갖춘 뒤 `pnpm db:migrate` — 멱등) → `qa_items.section_id`(uuid, nullable) 확인.
2. **env** — `.env.local` + Vercel에 `SLACK_QA_SLACK_ID=U…` 등록.
3. **씨앗 적재** — NotebookLM 영역별 Q&A 마크다운 작성 → `pnpm seed:exhibition <file.md> --dry-run`로 검증 후 `--dry-run` 빼고 적재. (섹션은 어드민 `/#/admin/sections`에서 먼저 생성, 이름 정확히 일치)
4. **Slack E2E** (ngrok + Slack 콘솔) — ① 채널 최상위 메시지 자동 감지 → 섹션 스코프 답변 ② `@철수 질문` ③ 스레드 `@철수 저장해줘` → 섹션 분류 저장 + 저장자 태그. QA 태그(`<@U…>`) 렌더 확인.

---

## 5. 미완료 / 다음

- **토스 테크니컬 라이팅 원칙** — `TOSS_WRITING_GUIDE`(현재 `''`)에 채울 예정.
- **NotebookLM 전시 데이터** — 실제 씨앗 마크다운 미작성 (`sample-exhibition.md`는 형식 예시).
- **실제 QA 담당자 ID** — `SLACK_QA_SLACK_ID` 값 설정 필요.
- **품질 테스트** — 적재 후 전시 질문 세트로 정확/누락/오답 + **분류 정확도** 측정 → 현행 유지 vs RAG 판단.

### 알려진 리스크
- `handler`가 `handleEvent`를 await 후 200 반환(즉시-ack 없음). 저장 경로에 분류 LLM 호출이 1개 늘어 지연 증가 → Slack 3초 초과 시 재전송·중복 저장 가능. 기존 구조적 이슈로 이번 범위에선 수용. (필요 시 `x-slack-retry-num` 헤더 디둡 추가)
- 섹션 스코프 쿼리는 LIMIT 없음(의도). 한 섹션이 비대해지면 추후 LIMIT 추가.
