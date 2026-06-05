# Part 3 PoC — 고객 조회 디스패처 (설계)

- 상태: 설계 v2 (6렌즈 적대적 검증 반영, 사용자 리뷰 대기)
- 날짜: 2026-06-04
- 상위 문서: 노션 "Part 3 — 봇 재정의" / "Part 3 작업 계획" / "Gate 1 — 인입 측정 결과"
- 범위: Part 3 작업계획의 **Phase 2 thin slice** 1개를 PoC로 구현. 어드민 API 첫 예제로 **Zelda 고객(customer) API** 사용.

---

## 0. 용어 (먼저 읽기)

| 용어 | 뜻 |
|---|---|
| `classifySection` | 질문이 어느 섹션(고객/상품/결제…)인지 분류 → 담당자 라우팅용. **기존 함수, 변경 없음.** 측정 자산. |
| `decideLookup` | "이 질문에 외부 조회가 필요한가? 필요하면 어떤 종류·파라미터인가"를 판단하는 **신규 LLM 콜**. |
| `executeLookup` | `decideLookup`의 계획을 **코드가 결정적으로 실행하는 디스패처**(`switch(type)`). |
| `searchCustomers` | 실제 Zelda 고객 API 호출(검색). `executeLookup`의 `customer_search` case가 부름. |
| `waitUntil` | 서버리스 함수가 HTTP 응답 후에도 백그라운드 Promise를 끝까지 살려주는 API. (배경 §4.0) |
| LLM-as-judge | 봇 답과 정답을 또 다른 LLM에 주고 맞/틀림을 자동 채점하는 방식. |

---

## 1. 목표 / 비목표

**목표**
- 봇이 "고객 관련 질문"에서 **로그인 ID(username)/이메일로 고객을 조회**해 결정적으로 답하고, 조회 키를 못 얻거나 조회에 실패하면 **담당자/QA로 라우팅**한다. (이름 검색은 zelda API 미지원 — §12.1)
- 이 흐름이 실제 인입에서 통하는지 **50건 실측 세트**로 측정해 "성공"을 처음으로 계측한다(PM 하드 트루스 #1 해소).
- 조회 종류를 늘릴 수 있는 **디스패처 구조(B-1)** 를 세워 다음 사이클에 상품/주문 등으로 확장 가능하게 한다.

**비목표 (이번 PoC에서 안 함)**
- 마스킹/PII 제거 — PoC는 **전체 노출**(§6). 운영 전환 시 별도 합의.
- 상품/주문 추가 조회 종류 — 구조만 열고 구현은 다음 사이클.
- 운영 채널 투입 — **단일 테스트 채널 강제**(§6, §9 게이트).
- RAG(pgvector), 영속 디둡(DB), 큐(QStash 등) — 운영 단계 항목.

---

## 2. 현재 코드 사실관계 (스펙 작성 시점)

- **핸들러** (`events.ts:37-89`): 서명 검증 → `event_id`를 `processedEventIds`에 **add(line 77)** → `await handleEvent(body.event)` → `res.status(200)`. 즉 **답변 생성이 끝난 뒤 200 반환**(동기). 비동기 ack 없음.
- `processedEventIds` (line 10): 인메모리 `Set`, 200개 cap **FIFO 제거**(insertion 순서 가장 오래된 event_id 삭제, LRU 아님). 서버 재시작·다중 인스턴스 미공유.
- `vercel.json`에 `maxDuration` 설정 **없음** → 플랜 기본값(대략 10~60s)에 의존. (실제 기본값 착수 시 확인)
- **답변 흐름** `composeReply()` (`events.ts:~210`): `classifySection()` → `fetchKnowledge()` → `generateAnswerFromItems()` → 담당자/QA 태그 + 토큰 사용량 라인.
- `classifySection()` → `{ section, usage }`. `generateAnswerFromItems()` → `{ answer, usage }`. **API 오류 시 라우팅이 아니라 에러 문자열**(`⏳…`/`⚠️…`)을 반환(events.ts:~544-553) — §4.3에서 처리.
- `composeReply`는 `handleQuestion`(멘션)과 `handleAutoQuestion`(자동) **양쪽에서 호출**. `handleAutoQuestion`에만 `SLACK_TARGET_CHANNEL_ID` 가드가 있고 그나마 `if (targetChannel && …)`라 **미설정 시 전 채널 동작**. 멘션 경로엔 채널 가드 없음.
- **`fetchKnowledge`** = `qa_items`의 Q&A 쌍(`KnowledgeRow[]`) 반환 — **"정책"이 아니라 KB**. CSV 전용 `fetchSectionPolicy`와 혼동 금지.
- **zelda.ts**: `listCustomers()`(= `/adminapi/v1/customer/` **첫 페이지만**, `next` 미추적), `getCustomer(id)`. **검색 함수 없음.** `CustomerSummary`에 `email`(line 12)·`phone`(line 13) 포함. **line 8 주석 "민감 필드 제거"는 사실과 다름**(§6에서 정정).

---

## 3. 합의된 결정

1. 어드민 API 첫 예제 = **Zelda 고객 API**. Phase 1-core(ROUTER_ONLY) 대신 Phase 2 thin slice를 PoC로 먼저(의도적).
2. 조회 키 = **로그인 ID(username)/이메일 검색**(접근안 2). ※ 당초 "이름/이메일"이었으나 zelda API가 username만 검색 가능해 정정(§12.1, 2026-06-05).
3. 아키텍처 = **B-1**: `classifySection`(유지) + `decideLookup`(신규 LLM 콜) + 합성. 콜 합치기(B-2) 안 함 — 측정 자산 보호 + 책임 분리.
4. 3초 문제 = **비동기로 해결**(즉시 ack + `waitUntil`). 콜 수 줄이기 아님.
5. PII = **PoC 전체 노출**, 단 §6의 가드·게이트 전제. 마스킹은 운영 전 팀 합의.
6. 성공 기준 = **50건 카테고리별 채점**(§7).

### 3.1 LLM 콜 수 / "2콜 바운드" 해석
노션의 "계획 LLM 콜 2콜 바운드"는 **계획 단계**(`classifySection` + `decideLookup` = 2콜)에 한정한다. 합성(`generateAnswerFromItems`)은 실행 단계라 바운드 밖. **lookup-hit 경로 총 콜 = 최대 3**(계획 2 + 합성 1)이며 의도된 것. (단 §3.2 D1을 "결정적 템플릿"으로 정하면 lookup-hit는 합성 콜이 없어 2콜.)

### 3.2 🔶 열린 결정 (사용자 입력 필요)

- **D1 — 고객 데이터를 LLM 합성에 통과시킬까?**
  - (a) **LLM 합성**: 고객 데이터(email/phone 포함)를 합성 프롬프트에 넣어 자연어 답변 생성. → PII가 Anthropic API로 전송됨 + 환각 위험.
  - (b) **결정적 템플릿(추천)**: lookup-hit이면 코드가 고정 템플릿으로 답(`고객 {name} · {status} · 차단 {blocked}` 등). LLM 미통과 → PII가 Anthropic에 안 감 + 사실 환각 0 + "결정적 조회" 목표에 부합. 정책 해석이 필요한 질문만 LLM 합성.
- **D2 — 자동응답 경로(`handleAutoQuestion`)에서도 고객 조회를 발동할까?**
  - (a) **멘션 전용(추천)**: 명시적 `@철수` 경로에서만 조회. 자동 경로는 PII 조회 비활성. 누군가 고객정보 담긴 글을 올리기만 해도 봇이 PII를 자동 조회·노출하는 일 방지.
  - (b) 자동 포함: 단, §6 채널 가드 필수.

---

## 4. 아키텍처 / 데이터 흐름

### 4.0 배경 — 왜 즉시 ack + waitUntil인가 (FE 개발자용)
서버리스 함수는 HTTP 응답을 보내면 실행이 **freeze(동결)** 될 수 있다. 그래서 `res.send()` 뒤에 일반 `await`로 LLM·API를 돌리면 중간에 죽는다. `@vercel/functions`의 `waitUntil(promise)`는 "응답 후에도 이 Promise 끝날 때까지 인스턴스를 살려라"라고 런타임에 알린다. 따라서 **ack(200)는 즉시, 실제 처리는 `waitUntil(handleEvent(...))`로 감싼다.** 현재 events.ts는 `await` 후 200이라, 이 순서를 뒤집는 게 2단계 핵심 변경이다.

### 4.1 핸들러 (디둡 + 비동기 ack)
```
Slack POST → 서명 검증
  └ event_callback:
       (현재) add(eventId) → await handleEvent → 200
       (변경) ① res.status(200) 즉시 ack
              ② waitUntil( run() )   ← handleEvent 전체(분기·composeReply·postMessage)를 감쌈
       run():
         if (processedEventIds.has(eventId)) return         // 디둡 체크는 유지
         try {
           await handleEvent(event)
           processedEventIds.add(eventId)                    // ★ 디둡 마킹을 "성공 후"로 이동
         } catch (e) {
           // 빈손 종료 금지(비동기판): 실패해도 무응답 0
           await postRoutingFallback(event)                  // 해당 스레드에 라우팅 메시지
           // eventId 미마킹 → Slack 재시도가 다시 시도 가능
         }
```
- **영구 무응답 방지(핵심):** 디둡 마킹을 `handleEvent` **성공 후**로 미룬다. 실패 시 마킹 안 함 → Slack 3초 재시도가 디둡에 막히지 않음. + 최상위 `try/catch`로 실패 시 라우팅 폴백 메시지 전송.
- **트레이드오프:** 성공 후 마킹은 "처리 중 재시도가 들어오면 중복 처리" 위험이 있다. PoC 단일 인스턴스+저트래픽엔 허용. (운영은 DB 멱등 디둡 — 범위 밖.)
- `waitUntil` 경계는 `composeReply`가 아니라 **`handleEvent` 전체**(postMessage 포함). `handleSave`/`handleCsvDiagnosis`도 함께 비동기화됨.

### 4.2 답변 흐름 (composeReply, lookup 끼워넣기)
```
composeReply(question, channelId)                            // ★ channelId 인자 추가
  ├ classifySection(question, sections)        → section (기존, 라우팅용)
  ├ 채널 가드: channelId === SLACK_TARGET_CHANNEL_ID?
  │     아니면 → decideLookup/executeLookup 스킵 (조회 없이 기존 동작 or 라우팅)
  ├ decideLookup(question, section)            → LookupPlan (신규, §5.2)
  ├ plan.lookup !== null && params 유효?
  │     └ executeLookup(plan.lookup)           → LookupResult
  │          status: hit | not_found | ambiguous | error
  ├ fetchKnowledge(section?.id)                → KnowledgeRow[] (정책 아님; hit/합성 경로에서만 호출)
  └ 분기:
       • hit              → 답변(§3.2 D1: 템플릿 or 합성) + 담당자 태그
       • not_found        → "고객 못 찾음, 이메일/이름 재확인" + 라우팅
       • ambiguous(N≥2)   → "여러 건 검색됨, 더 구체적 정보 필요" + 라우팅 (이름/이메일 미포함)
       • error            → "일시 오류" + 라우팅 (reason은 console.error만)
       • lookup 불필요     → 기존 KB 답변/라우팅 (현행 유지)
```

### 4.3 실패 폴백 단일 원칙 (합성 실패 포함)
"실행/합성이 막히면 항상 라우팅"을 합성 단계까지 일관 적용한다. 현재 `generateAnswerFromItems`는 API 오류 시 에러 문자열을 반환 → **이를 라우팅으로 강등**한다. 구현: `generateAnswerFromItems`가 `{ answer, usage, ok }` 또는 throw로 실패를 알리게 조정하고, `composeReply`가 `ok===false`면 라우팅 폴백. (D1을 템플릿으로 정하면 lookup-hit는 합성 자체가 없어 이 경로 회피.)

### 4.4 LLM 헛다리 방지
`lookup.type`은 enum 화이트리스트 택1(현재 `['customer_search']`). `decideLookup`이 엉뚱한 type/빈 params를 내면 코드가 **호출하지 않고 라우팅**. free-form 쿼리 금지.

---

## 5. 컴포넌트 / 인터페이스

### 5.1 `api/_lib/zelda.ts` — 검색 추가 + 주석 정정
```ts
// 신규
export async function searchCustomers(query: string): Promise<CustomerSummary[]>
//   서버 검색: GET /adminapi/v1/customer/?search={encodeURIComponent(query)}  (파라미터 존재 = §9 게이트)
//   query는 화이트리스트 통과값만(이메일 정규식 / 길이·문자 제한). 인코딩 필수(파라미터 인젝션 방지).
//   매칭: zelda ?search=는 username(로그인 ID) contains만(이름·code·id 불가, §12.1). 이메일 형태면 정확 소문자 우선. 부분 일치 다수 → ambiguous로 강등.
//   서버 검색 파라미터가 없으면 폴백: 첫 페이지(~50건) 클라이언트 필터만. 전체 순회 금지.
//     → 폴백은 모수가 작아 대부분 not_found→라우팅. 측정에서 "API 한계 라우팅"으로 별도 집계(§7).
```
- **주석 정정:** `zelda.ts:8`의 "민감 필드 제거"는 사실과 다름 → "PoC: Slack 노출 필드(이메일/전화 포함, 마스킹 미적용). 운영 전환 시 마스킹/필드 제거 필수"로 수정. `pickSafeFields`는 "마스킹"이 아니라 **직렬화 화이트리스트(PII 포함)** 임을 명시.

### 5.2 `api/_lib/lookup.ts` (신규)
```ts
export type LookupType = 'customer_search'   // 확장: 'product_by_code' | 'order_by_number' ...

// 모순 상태(needs_lookup=true인데 lookup=null) 차단: discriminated union
export type LookupPlan =
  | { needs_lookup: false }
  | { needs_lookup: true; lookup: { type: LookupType; params: { query: string } } }

export type LookupResult =
  | { status: 'hit'; type: LookupType; data: CustomerSummary }   // unknown 아님
  | { status: 'not_found' }
  | { status: 'ambiguous'; count: number }                       // count>=2, 이름/이메일 미포함
  | { status: 'error'; reason: string }

// LLM 콜 1개. classifySection과 직교. usage 함께 반환.
export async function decideLookup(
  question: string, section: Section | null,
): Promise<{ plan: LookupPlan; usage: TokenUsage }>

// params 검증(타입별) 후 결정적 디스패치. customer_search: params.query 비공백 필수.
export async function executeLookup(
  lookup: { type: LookupType; params: { query: string } },
): Promise<LookupResult>
```
- `executeLookup`의 `switch(type)` case 추가 = 조회 종류 확장 지점. 질문 흐름 코드 불변.
- **params 유효성**: `customer_search`는 `params.query`가 비공백 1자 이상. 없거나 공백이면 호출 스킵→라우팅. 검증은 `executeLookup` 진입 전 한 곳에서.

### 5.3 `events.ts` — 와이어링
- `handler`: §4.1 (즉시 ack + waitUntil + 디둡 마킹 성공 후 이동 + 실패 라우팅 폴백).
- `composeReply(question, channelId)`: 채널 가드 → `decideLookup` → (조건부)`executeLookup` → 분기(§4.2).
- **답변 합성 시그니처(D1=합성 택할 때만)**: `generateAnswerFromItems(question, items, lookupContext?)`. `lookupContext` = hit 시 `CustomerSummary`를 사람이 읽는 텍스트로 포맷한 문자열. user 메시지에 주입. **호출부 `handleSave` 등은 시그니처 영향 없음**(선택 인자).
- **토큰 usage 합산**: `composeReply`에 단일 accumulator(`classifyUsage + decideLookupUsage + answerUsage?`). **모든 return 경로**(hit/not_found/ambiguous/error/키없음/분류실패)가 동일하게 `formatTokenLine(accumulated)`로 끝냄. 조회 불필요면 lookup usage=0.

### 5.4 `scripts/eval-lookup.ts` + 골든셋 — 측정
- 오프라인·재현 가능(운영 트래픽 아님).
- **골든셋에 실제 고객 PII를 커밋하지 않는다.** 조회키는 테스트용 더미 고객 데이터 또는 시크릿에서 주입. 비식별 규칙 명문화.
- 출력: 카테고리별 `(정답/N)`·비율·신뢰구간(또는 ±오차)·치명적 오답 건수·LLM-judge vs 사람 일치율을 JSON+마크다운 표로.

---

## 6. PII / 보안

- **PoC: 고객 PII(email/phone) 마스킹 없이 전체 노출.** 단 아래 가드 전제.
- **🔴 채널 가드(필수):** 조회·노출은 `SLACK_TARGET_CHANNEL_ID`와 일치하는 채널에서만. 이 변수는 PoC 필수 — **미설정 시 조회 비활성화(또는 부팅 실패)**. 멘션·자동 양 경로 모두 가드 통과 후에만 `executeLookup`. 가드 밖 채널은 라우팅. (§9 게이트)
- **명시 리스크(기록):**
  - hit(1건)이어도 그 1명의 email/phone이 채널 평문 노출 = 유출. 요청자가 정당한 담당자인지 확인 불가 + 채널 타 구성원에게 노출. `ambiguous`는 "여러 명 덤프"만 막을 뿐 단건 노출은 못 막음.
  - (D1=합성일 때) PII가 **Anthropic API로 전송 + LLM이 재출력 + Slack 스레드 영구 기록.** D1=템플릿이면 Anthropic 미전송.
- **감사 로깅:** 조회 1건마다 `{요청자 slack id, 채널 id, type, 쿼리(이메일은 해시/마스킹), 결과 status, ts}`를 구조화 로그로. **PII 평문(email/phone 값)은 로그·console에 안 남김.** `LookupResult.data`를 그대로 `console.log` 금지.
- **팀 논의 안건(운영 전환 전 필수, 노션 §6 기록):** 마스킹/공개 항목 제한. Gate 1에서 채널 PII 평문 노출 관찰됨 → 봇이 조회마다 자동·반복 **증폭**.

---

## 7. 측정 / 성공 기준 (50건 실측)

### 7.1 표본 구성
- **카테고리별 최소 표본:** 상태조회 ≥ 15, 정책 ≥ 15, 라우팅 ≥ 15 목표로 50건 구성. 상태조회 부족 시 **조회키 포함 질문 우선 샘플링**으로 최소 충족. 카테고리 N<10이면 그 정답률은 **참고치**로만(go/no-go 근거 제외).
- **샘플링 규칙:** 동일 thread/incident는 대표 1건만(중복 incident 배제). 단일 채널 편향 인지, 가능하면 2채널 이상 비례 추출. 추출 기간·정렬(무작위/최근순) 기록.
- **출처/재현:** Gate 1의 50건 재사용 여부를 착수 시 확정. 골든셋엔 실제 PII 미커밋(§5.4).

### 7.2 카테고리별 채점
| 카테고리 | 성공 | 채점 |
|---|---|---|
| 상태조회 (조회키 O) | API 근거로 맞음 | 자동 ○/✗ |
| 정적 정책 | 실제 답과 방향 일치 | 사람 |
| 라우팅 (조회 불가) | **올바른 담당자에게 감 = 성공**(1급) | 자동 |

- **분류 주체:** 사람 라벨러가 답변 생성 **전** 확정(봇 출력과 독립). 결정적 조회로 답 가능→상태조회, KB/정책 해석 필요→정책, 근거 없어 사람 연결이 정답→라우팅. 둘에 걸치면 **결정적 조회 우선**. 라벨링 2인+불일치 조정 권장.
- **라우팅 정답 라벨:** 사람 라벨러가 실제 처리 이력/섹션 소유권 기준으로 **봇 매핑과 독립적으로 사전 지정**. 채점은 "봇 라우팅 == 사람 지정 정답". (봇의 `curator_slack_id` 매핑을 정답으로 쓰면 순환 채점이 되므로 금지.)

### 7.3 치명적 오답(추측성 오답)
- 정의: (1) 라우팅/유보가 정답인 상황에서 (2) 사실 주장형 답변을 생성했고 (3) 그 주장이 사실과 다르거나 검증 불가.
- **판정자: 사람만**(LLM-judge 자동 금지). **목표 0건**(go/no-go 게이트).

### 7.4 채점 방식 (혼합 C) + judge 신뢰성
- 명확한 ○/✗(상태조회·라우팅) = LLM-as-judge 자동 + 사람 스팟체크. 애매한 정책 = 사람.
- judge는 **답변 생성과 다른 모델/프롬프트**. 사람 라벨 N건(예 20)에 먼저 돌려 일치율 ≥90% 확인 후에만 자동 신뢰. 자동 판정 최소 20% 사람 재확인, **불일치 시 사람 채택**.

### 7.5 통과 임계값 (측정 전 숫자 고정)
- **베이스라인 = 현재 봇(고객 조회 비활성·decideLookup 미적용)을 동일 50건에 돌린 결과.**
- 통과: `상태조회 정답률 ≥ X% AND 라우팅 정확도 ≥ Y% AND 치명적 오답 0건` **또는** `베이스라인 대비 절대 +Z%p 이상`. (X·Y·Z는 베이스라인 측정 직후 확정 — "의미 있게 높음" 같은 정성어 금지.)

---

## 8. 단계 (구현은 writing-plans에서 상세화)

1. (게이트, §9) Zelda 검색 파라미터·토큰 읽기전용·단일 테스트 채널 확인
2. 즉시 ack + `waitUntil` + 디둡 마킹 이동 + 실패 라우팅 폴백 (§4.1)
3. `zelda.searchCustomers`(+주석 정정) + `lookup.ts`(decideLookup/executeLookup, customer_search)
4. `composeReply(question, channelId)` 와이어링 + 채널 가드 + 폴백 + 토큰 합산 (§4.2~5.3)
5. `eval-lookup.ts` + 골든셋 50건 → 베이스라인 측정 → 임계값 확정 → 본 측정 → go/조정

---

## 9. 🔴 착수 전 게이트 (코드 전 확인)

- [ ] **Zelda 검색 파라미터** `?search=`(또는 `?email=`) 존재? 없으면 §5.1 폴백(첫 페이지)로 한정 — PoC 결과 왜곡 감수.
- [ ] **`ZELDA_API_TOKEN`이 customer read-only 스코프**임을 발급처에서 확인. (쓰기 가능 토큰이면 인젝션 시 변조 위험 → 착수 금지.)
- [ ] **단일 테스트 채널 강제** — `SLACK_TARGET_CHANNEL_ID` 설정 + 멘션/자동 양 경로 가드 (§6).
- [ ] **D1/D2 결정**(§3.2) — PII LLM 통과 여부 / 자동응답 조회 여부.
- [ ] 테스트 더미 고객 데이터 존재 + 골든셋 PII 비커밋 방침(§5.4).

---

## 10. 오픈 이슈 (게이트 외)
- 한국어 이름 추출은 `decideLookup`(LLM) 의존 → 오인식 위험. query sanity 체크(1자 미만·과흔한 토큰 거부) + 못 뽑으면 라우팅.
- `waitUntil` 동작이 `vercel dev`(로컬+ngrok)와 배포에서 다를 수 있음 → 유실 시 §4.1 폴백으로 무응답 0 보장.
- 흐름 효율: 라우팅 확정 경로에서 `fetchKnowledge` DB 쿼리 생략(or 측정 단순화 위해 유지 — 한 줄 근거 기록).

---

*다음 컨텍스트가 이어받도록 노션(Part 3 / 작업계획)에 요약 반영한다.*

---

## 11. 구현 메모 (2026-06-04)

**결정 확정:** D1 = (b) **결정적 템플릿**(lookup-hit은 LLM 미통과, `formatCustomer`). D2 = (b) **멘션 전용**(`handleAutoQuestion`은 조회 비활성).

**구현된 것:**
- `api/_lib/zelda.ts` — `searchCustomers(query)` 추가(`?search=` + 인코딩, 이메일이면 정확일치 우선). **모듈 로드 시 env throw 제거** → 호출 시점(`zeldaFetch`)으로 이동(ZELDA env 없어도 봇 라우팅/KB는 동작). 주석 정정.
- `api/_lib/lookup.ts` (신규) — `decideLookup`(LLM 계획) + `executeLookup`(디스패처) + 타입(`LookupPlan` discriminated union, `LookupResult`).
- `api/slack/events.ts` — 즉시 200 ack + `scheduleBackground`(waitUntil) + 디둡 마킹 성공 후 이동 + 실패 시 `postRoutingFallback`. `composeReply(question, {channelId, allowLookup})` 채널 가드·디스패처·`formatCustomer`·토큰 합산·합성실패 라우팅 강등. `generateAnswerFromItems`에 `ok` 추가. `handleQuestion`만 `allowLookup: true`.
- `vercel.json` — `functions.maxDuration: 30`.

**`@vercel/functions` 결정:** 하드 의존성으로 넣지 않고 **동적 import + graceful fallback**(`scheduleBackground`). 없으면 fire-and-forget — `vercel dev`(houston PoC)에선 백그라운드가 그대로 완료된다. **프로덕션 serverless 배포 시 `pnpm add @vercel/functions` 필요**(동결 방지). 버전을 검증할 수 없어 install 실패 위험을 피하려는 선택.

**이연(이번 커밋 안 함):**
- `scripts/eval-lookup.ts` + 골든셋 50건 + 베이스라인 측정(§7) — 데이터·베이스라인 필요해 별도 단계.
- 감사 로깅(§6) — 운영 항목.

**검증 한계:** 이 워크스페이스엔 node_modules 없음 → **컴파일/실행 검증 못 함**. 정독 리뷰만 수행. **houston에서 스모크 테스트 필수**(`pnpm install` 후 멘션→고객조회). 착수 전 게이트(§9: Zelda `?search=` 존재, 토큰 read-only, 단일 테스트 채널)는 미해소 상태.

---

## 12. 조회 종류 확장 — `product_by_code` + `order_by_number` (2026-06-05)

### 12.0 배경 / 검증된 사실
- **로컬 end-to-end 스모크 통과**(2026-06-05): chennai에서 `customer_search` hit→결정적 템플릿→Slack 게시 확인. 타입체크 strict 0에러. `@vercel/functions` 설치(waitUntil — vercel dev 동결 방지).
- **게이트 해소**: `?search=`는 zelda `CustomerFilterSet.search`로 존재 확인. ZELDA는 **로컬 dev**(`localhost:8000`)라 토큰 read-only 게이트 N/A. 단일 테스트 채널 `SLACK_TARGET_CHANNEL_ID=C0B4HL61KGB` 설정.
- **스코프 동기**: Gate 1 실측 조회키 = 상품코드 10·주문번호 3·고객식별 3 → 구현이 `customer_search`뿐이면 실인입 대부분 라우팅으로 떨어짐. 실측 상위 2개 키(상품·주문)를 커버해 디스패처를 실질화한다. **데이터는 로컬에 없을 수 있어 API 래퍼·디스패처 구조만 먼저** 깔고, 시드/eval은 이연.

### 12.1 zelda 어드민 엔드포인트 매핑 (조사 결과)
| lookup type | 엔드포인트 | 조회 | 노출 필드(화이트리스트) | PII |
|---|---|---|---|---|
| `customer_search` (기존) | `/adminapi/v1/customer/?search=` | **username(로그인 ID) contains만** — 이름(display_name)·code·id로는 검색 불가(2026-06-05 dev 실측) | display_name, email, phone, status, blocked, code, created | email/phone |
| `product_by_code` (신규) | `/adminapi/v1/product/?search=` | search_fields(code, custom_code, name…) | code, name, price, selling, display, status (※ list 직렬화에 custom_code 미포함) | **없음** |
| `order_by_number` (신규) | `/adminapi/v1/order/?search=` | search_fields(code, customer__email…) | **code, ordered, paid, payment_amount, payment_method, item_statuses** | **없음(아래 D3)** |

### 12.2 결정 (D3 — order 출력 화이트리스트)
- **D3 = (A) 상태 필드만.** order 응답에 `customer_email / receiver_phone / receiver_address`가 있으나 **노출하지 않는다.** 실측 주문 질문은 결제완료/환불/반품 *상태* 확인이라 고객 PII 불필요. → 신규 2종은 PII-청정(`product`=원천 없음, `order`=상태필드만). PII 보유는 `customer_search`로 격리 유지.

### 12.3 컴포넌트 변경
**`zelda.ts`** — 래퍼 2개 추가(customer와 동일 `?search=`+인코딩 패턴):
```ts
export interface ProductSummary { code; name; price; selling; display; status }   // SimplestProductSerializer
export interface OrderSummary   { code; ordered; paid; payment_amount; payment_method; item_statuses } // SimpleAdminOrderSerializer, D3: 고객 PII 제외
// 주: order 'paid'는 결제완료 datetime|null → Boolean() 강제변환(결제완료 여부). item_statuses = orderitem_set[].status.
//     '?search='의 list 직렬화는 product=SimplestProductSerializer, order=SimpleAdminOrderSerializer 기준.
export async function searchProducts(query: string): Promise<ProductSummary[]>
export async function searchOrders(query: string): Promise<OrderSummary[]>
// 각자 pickXFields 화이트리스트. 실제 serializer 필드명은 구현 시 확정(ProductSerializer/OrderSerializer).
```

**`lookup.ts`** — 멀티 타입:
```ts
export type LookupType = 'customer_search' | 'product_by_code' | 'order_by_number'
// params는 {query: string} 통일 (타입별 분기 없음). LookupPlan discriminated union 유지.
export type LookupResult =
  | { status: 'hit'; type: LookupType; data: CustomerSummary | ProductSummary | OrderSummary }
  | { status: 'not_found' } | { status: 'ambiguous'; count: number } | { status: 'error'; reason: string }
// executeLookup: switch에 case 'product_by_code'→searchProducts, 'order_by_number'→searchOrders 추가.
//   hit/not_found/ambiguous(≥2) 로직 재사용.
```
- `decideLookup` 프롬프트 개정: 이메일/사람이름→`customer_search`, 상품코드→`product_by_code`, 주문번호→`order_by_number`, 없으면 `needs_lookup:false`. 타입 enum 화이트리스트 강제. **모호/검증 실패 시 호출 안 하고 라우팅**(fail-safe 유지).

**`events.ts`** — `formatProduct(p)` / `formatOrder(o)` 추가. `composeReply` hit 분기가 `result.type`로 포매터 선택(결정적 템플릿, D1 유지, LLM 미통과).

### 12.4 비범위 / 이연
- `settlement_invoice`, `partner_by_code` — 수요 좁고 사업자 PII → 다음 사이클.
- URL링크에서 코드 추출(정규식) → 다음 사이클(우선 사용자가 코드/번호를 직접 적은 경우만).
- 로컬 더미 상품/주문 시드 + eval 50건(§7) — lookup 확장 후 별도 단계.
- 데이터 부재 시 동작: `not_found → 라우팅`(안전). 구조만 선반영.
