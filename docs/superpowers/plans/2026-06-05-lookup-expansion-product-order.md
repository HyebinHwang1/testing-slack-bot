# Lookup 확장 (product_by_code + order_by_number) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 `customer_search` 디스패처에 `product_by_code`·`order_by_number` 두 조회 종류를 추가해, Gate 1 실측 상위 조회키(상품코드·주문번호)를 커버한다. 데이터는 로컬에 없을 수 있으므로 **API 래퍼 + 디스패처 구조만** 우선 구현(없으면 not_found→라우팅).

**Architecture:** B 디스패처 패턴 유지 — LLM(`decideLookup`)이 type+검색어만 고르고, 코드(`executeLookup`)가 enum 화이트리스트로 결정적 디스패치. zelda 어드민 `?search=` 엔드포인트를 호출하는 얇은 래퍼(`searchProducts`/`searchOrders`)에 **출력 필드 화이트리스트**를 적용(order는 고객 PII 제외 = 스펙 §12.2 D3=A). 결정적 템플릿(D1) 유지 — hit이면 LLM 미통과, 코드가 포맷.

**Tech Stack:** TypeScript (ESM, nodenext), `@anthropic-ai/sdk`(haiku), zelda Django adminapi(`/adminapi/v1/`), 테스트 = `node:test` + `tsx`.

**관련 스펙:** `docs/superpowers/specs/2026-06-04-part3-customer-lookup-poc-design.md` §12.

---

## 파일 구조

| 파일 | 책임 | 작업 |
|---|---|---|
| `api/_lib/zelda.ts` | zelda 어드민 호출 래퍼 + 출력 화이트리스트 | Modify — ProductSummary/OrderSummary + pick*/search* 추가 |
| `api/_lib/lookup.ts` | 조회 계획(LLM) + 결정적 디스패처 | Modify — LookupType 3종, parse/toLookupResult 추출, executeLookup case 추가, decideLookup 프롬프트 |
| `api/_lib/format.ts` | 조회 결과 → Slack 텍스트 (순수 함수) | **Create** — formatCustomer(이동) + formatProduct/formatOrder + formatLookupHit |
| `api/slack/events.ts` | 핸들러/라우팅/composeReply | Modify — hit 분기를 `formatLookupHit`로, formatCustomer 제거+import |
| `api/_lib/zelda.test.ts` | 화이트리스트(특히 order PII drop) 검증 | Create |
| `api/_lib/lookup.test.ts` | parseLookupPlan/toLookupResult 검증 | Create |
| `api/_lib/format.test.ts` | 포맷 텍스트 검증 | Create |
| `package.json` | `test` 스크립트 | Modify |

**결정 근거:** 포매터를 `format.ts`로 분리하는 이유 — (1) 순수 함수라 단위 테스트가 쉽다, (2) `events.ts`(~950줄)가 비대해 분리가 정당, (3) `events.ts`는 `db.ts`(런타임 `sql`)를 import하므로 테스트에서 import하면 DB 클라이언트가 로드된다. `format.ts`는 **타입만** import(zelda/lookup)해 런타임 의존성이 0 → 안전하게 테스트 가능.

---

## Task 0: 테스트 러너 셋업 (node:test + tsx)

**Files:**
- Modify: `package.json` (scripts)
- Test: `api/_lib/format.test.ts` (임시 sanity)

- [ ] **Step 1: `package.json`에 test 스크립트 추가**

`scripts`에 추가 (기존 항목 유지):
```json
"test": "node --import tsx --test api/_lib/format.test.ts api/_lib/lookup.test.ts api/_lib/zelda.test.ts"
```
> 주: `node --test`는 `.ts`를 자동 발견하지 않으므로 파일을 **명시 나열**한다. 아래 태스크에서 세 테스트 파일을 모두 만든다.

- [ ] **Step 2: sanity 테스트 파일 작성** (`api/_lib/format.test.ts`)

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('sanity: 테스트 러너 동작', () => {
  assert.equal(1 + 1, 2)
})
```

- [ ] **Step 3: 빈 테스트 파일 2개 생성** (스크립트가 참조하므로)

`api/_lib/lookup.test.ts`, `api/_lib/zelda.test.ts` 각각:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('placeholder', () => { assert.ok(true) })
```

- [ ] **Step 4: 실행해서 통과 확인**

Run: `pnpm test`
Expected: PASS (3개 파일, 3 tests passing). `tsx`가 `.ts`를 로드하지 못하면 Node ≥20.6 + `tsx` devDep 확인.

- [ ] **Step 5: Commit**

```bash
git add package.json api/_lib/format.test.ts api/_lib/lookup.test.ts api/_lib/zelda.test.ts
git commit -m "test: node:test + tsx 러너 셋업"
```

---

## Task 1: zelda.ts — 상품 검색 래퍼 (`searchProducts`)

**Files:**
- Modify: `api/_lib/zelda.ts`
- Test: `api/_lib/zelda.test.ts`

배경: 상품 list 응답은 `SimplestProductSerializer` (fields: code, name, price, selling, display, status …). PII 없음. `?search=`는 search_fields(code/custom_code/name…)로 매칭.

- [ ] **Step 1: 실패 테스트 작성** (`zelda.test.ts` — placeholder 교체)

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { searchProducts } from './zelda.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stubFetch(jsonBody: unknown) {
  const calls: string[] = []
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    return { ok: true, status: 200, json: async () => jsonBody } as Response
  }) as typeof fetch
  return calls
}

test('searchProducts: ?search= 호출 + 화이트리스트 필드만 반환', async () => {
  process.env.ZELDA_API_URL = 'http://localhost:8000'
  process.env.ZELDA_API_TOKEN = 't'
  const calls = stubFetch({
    next: null, previous: null,
    results: [{ id: 1, code: 'P-1', custom_code: 'ABC-123', name: '신발', price: 1000,
                selling: true, display: false, status: 'on_sale', supply_name: '내부공급명-비공개' }],
  })
  const out = await searchProducts('ABC-123')
  assert.match(calls[0], /\/adminapi\/v1\/product\/\?search=ABC-123$/)
  assert.deepEqual(out, [{ code: 'P-1', name: '신발', price: 1000, selling: true, display: false, status: 'on_sale' }])
  // supply_name(내부 공급명) 등 비화이트리스트 필드는 누락
  assert.equal((out[0] as Record<string, unknown>).supply_name, undefined)
})
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test`
Expected: FAIL — `searchProducts` is not exported / not a function.

- [ ] **Step 3: 구현** (`zelda.ts` — `searchCustomers` 아래에 추가)

```ts
export interface ProductSummary {
  code: string
  name: string
  price: number | null
  selling: boolean
  display: boolean
  status: string | null
}

// 공통 list 응답(raw 행). pickXFields가 노출 필드로 좁힌다.
interface ZeldaListResponse {
  next: string | null
  previous: string | null
  results: Record<string, unknown>[]
}

function pickProductFields(raw: Record<string, unknown>): ProductSummary {
  return {
    code: raw.code as string,
    name: raw.name as string,
    price: (raw.price as number | null) ?? null,
    selling: Boolean(raw.selling),
    display: Boolean(raw.display),
    status: (raw.status as string | null) ?? null,
  }
}

// 상품 검색. 자사상품코드/코드/이름 부분일치(zelda search_fields). 인코딩 필수.
export async function searchProducts(query: string): Promise<ProductSummary[]> {
  const q = query.trim()
  if (!q) return []
  const data = await zeldaFetch<ZeldaListResponse>(
    `/adminapi/v1/product/?search=${encodeURIComponent(q)}`,
  )
  return data.results.map(pickProductFields)
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/zelda.ts api/_lib/zelda.test.ts
git commit -m "feat: zelda.searchProducts (상품 ?search= 래퍼 + 출력 화이트리스트)"
```

---

## Task 2: zelda.ts — 주문 검색 래퍼 (`searchOrders`, 고객 PII 제외)

**Files:**
- Modify: `api/_lib/zelda.ts`
- Test: `api/_lib/zelda.test.ts`

배경: 주문 list 응답은 `SimpleAdminOrderSerializer` (fields: code, ordered, customer_name, payment_amount, paid, payment_method, orderitem_set[].status, customer_object{…}). **D3=A: customer_name/customer_object/email/phone 등 고객 PII를 노출하지 않는다** — 상태 필드만 화이트리스트.

- [ ] **Step 1: 실패 테스트 추가** (`zelda.test.ts`에 append)

```ts
import { searchOrders } from './zelda.js'

test('searchOrders: 상태 필드만, 고객 PII는 제외(D3)', async () => {
  process.env.ZELDA_API_URL = 'http://localhost:8000'
  process.env.ZELDA_API_TOKEN = 't'
  const calls = stubFetch({
    next: null, previous: null,
    results: [{
      id: 9, code: 'O-100', ordered: '2026-05-01T10:00:00+09:00',
      paid: true, payment_amount: 5000, payment_method: 'card',
      orderitem_set: [{ status: 'shipped' }, { status: 'delivered' }],
      customer_name: '홍길동',                       // PII — 제외돼야
      customer_object: { first_name: '길동', last_name: '홍' }, // PII — 제외돼야
      customer_email: 'x@y.com', customer_phone: '010-0000-0000', // PII — 제외돼야
    }],
  })
  const out = await searchOrders('O-100')
  assert.match(calls[0], /\/adminapi\/v1\/order\/\?search=O-100$/)
  assert.deepEqual(out, [{
    code: 'O-100', ordered: '2026-05-01T10:00:00+09:00', paid: true,
    payment_amount: 5000, payment_method: 'card', item_statuses: ['shipped', 'delivered'],
  }])
  const keys = Object.keys(out[0])
  for (const pii of ['customer_name', 'customer_object', 'customer_email', 'customer_phone']) {
    assert.ok(!keys.includes(pii), `PII 키 노출됨: ${pii}`)
  }
})
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test`
Expected: FAIL — `searchOrders` not exported.

- [ ] **Step 3: 구현** (`zelda.ts` — Task 1 코드 아래에 추가)

```ts
export interface OrderSummary {
  code: string
  ordered: string | null
  paid: boolean
  payment_amount: number | string | null
  payment_method: string | null
  item_statuses: string[]
}

// D3=A: 주문 상태 필드만. customer_name/customer_object/email/phone 등 고객 PII는 의도적으로 읽지 않는다(누락=비노출).
function pickOrderFields(raw: Record<string, unknown>): OrderSummary {
  const items = Array.isArray(raw.orderitem_set)
    ? (raw.orderitem_set as Array<Record<string, unknown>>)
    : []
  return {
    code: raw.code as string,
    ordered: (raw.ordered as string | null) ?? null,
    paid: Boolean(raw.paid),
    payment_amount: (raw.payment_amount as number | string | null) ?? null,
    payment_method: (raw.payment_method as string | null) ?? null,
    item_statuses: items.map((i) => i.status as string).filter(Boolean),
  }
}

// 주문 검색. 주문번호(code) 등 부분일치(zelda search_fields). 인코딩 필수.
export async function searchOrders(query: string): Promise<OrderSummary[]> {
  const q = query.trim()
  if (!q) return []
  const data = await zeldaFetch<ZeldaListResponse>(
    `/adminapi/v1/order/?search=${encodeURIComponent(q)}`,
  )
  return data.results.map(pickOrderFields)
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/zelda.ts api/_lib/zelda.test.ts
git commit -m "feat: zelda.searchOrders (주문 ?search= 래퍼, 고객 PII 제외=D3)"
```

---

## Task 3: lookup.ts — 멀티 타입 + 순수 헬퍼 추출 (`parseLookupPlan`, `toLookupResult`)

**Files:**
- Modify: `api/_lib/lookup.ts`
- Test: `api/_lib/lookup.test.ts`

- [ ] **Step 1: 실패 테스트 작성** (`lookup.test.ts` — placeholder 교체)

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLookupPlan, toLookupResult } from './lookup.js'

test('parseLookupPlan: 3개 type 모두 화이트리스트 통과', () => {
  for (const type of ['customer_search', 'product_by_code', 'order_by_number']) {
    const plan = parseLookupPlan(`{"needs_lookup":true,"lookup":{"type":"${type}","params":{"query":"x"}}}`)
    assert.deepEqual(plan, { needs_lookup: true, lookup: { type, params: { query: 'x' } } })
  }
})

test('parseLookupPlan: 화이트리스트 밖 type → needs_lookup:false (free-form 금지)', () => {
  const plan = parseLookupPlan('{"needs_lookup":true,"lookup":{"type":"sql_query","params":{"query":"DROP"}}}')
  assert.deepEqual(plan, { needs_lookup: false })
})

test('parseLookupPlan: query 비거나 JSON 아니면 false', () => {
  assert.deepEqual(parseLookupPlan('{"needs_lookup":true,"lookup":{"type":"product_by_code","params":{"query":"  "}}}'), { needs_lookup: false })
  assert.deepEqual(parseLookupPlan('설명만 있고 JSON 없음'), { needs_lookup: false })
})

test('toLookupResult: 0→not_found, 2+→ambiguous, 1→hit', () => {
  assert.deepEqual(toLookupResult('product_by_code', []), { status: 'not_found' })
  assert.deepEqual(toLookupResult('product_by_code', [{} as never, {} as never]), { status: 'ambiguous', count: 2 })
  const one = { code: 'P-1' } as never
  assert.deepEqual(toLookupResult('product_by_code', [one]), { status: 'hit', type: 'product_by_code', data: one })
})
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test`
Expected: FAIL — `parseLookupPlan`/`toLookupResult` not exported.

- [ ] **Step 3: 구현** — `lookup.ts` 수정

(a) import에 추가:
```ts
import { searchCustomers, searchProducts, searchOrders, type CustomerSummary, type ProductSummary, type OrderSummary } from './zelda.js'
```

(b) `LookupType`/`LOOKUP_TYPES` 교체:
```ts
export type LookupType = 'customer_search' | 'product_by_code' | 'order_by_number'
const LOOKUP_TYPES: LookupType[] = ['customer_search', 'product_by_code', 'order_by_number']
```

(c) `LookupResult` 의 `data` union 교체:
```ts
export type LookupResult =
  | { status: 'hit'; type: LookupType; data: CustomerSummary | ProductSummary | OrderSummary }
  | { status: 'not_found' }
  | { status: 'ambiguous'; count: number }
  | { status: 'error'; reason: string }
```

(d) 순수 헬퍼 2개 추가 (파일 상단, decideLookup 위):
```ts
// LLM 출력 텍스트 → 검증된 LookupPlan. enum 화이트리스트 강제(free-form 금지).
export function parseLookupPlan(rawText: string): LookupPlan {
  const match = rawText.match(/\{[\s\S]*\}/)
  if (!match) return { needs_lookup: false }
  let parsed: { needs_lookup?: boolean; lookup?: { type?: string; params?: { query?: string } } }
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return { needs_lookup: false }
  }
  const type = parsed.lookup?.type
  const query = typeof parsed.lookup?.params?.query === 'string' ? parsed.lookup.params.query.trim() : ''
  if (!parsed.needs_lookup || !type || !LOOKUP_TYPES.includes(type as LookupType) || !query) {
    return { needs_lookup: false }
  }
  return { needs_lookup: true, lookup: { type: type as LookupType, params: { query } } }
}

// 검색 결과 개수 → 결정적 status. 0=not_found, ≥2=ambiguous(PII 덤프 회피), 1=hit.
export function toLookupResult(
  type: LookupType,
  results: Array<CustomerSummary | ProductSummary | OrderSummary>,
): LookupResult {
  if (results.length === 0) return { status: 'not_found' }
  if (results.length >= 2) return { status: 'ambiguous', count: results.length }
  return { status: 'hit', type, data: results[0] }
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm test`
Expected: PASS (lookup.test.ts 4 tests).

- [ ] **Step 5: Commit**

```bash
git add api/_lib/lookup.ts api/_lib/lookup.test.ts
git commit -m "feat: lookup 멀티타입 + parseLookupPlan/toLookupResult 추출(테스트)"
```

---

## Task 4: lookup.ts — `executeLookup` 디스패치 + `decideLookup` 프롬프트 개정

**Files:**
- Modify: `api/_lib/lookup.ts`

이 태스크는 LLM 호출(`decideLookup`)과 네트워크(`executeLookup`)라 단위 테스트 대신 **타입체크 + Task 7 통합 스모크**로 검증한다. (순수 부분은 Task 3에서 이미 커버.)

- [ ] **Step 1: `executeLookup` 를 `toLookupResult` 기반 디스패처로 교체**

기존 `executeLookup` 본문 전체를 교체:
```ts
// 계획을 코드가 결정적으로 디스패치. type별 search 호출 후 toLookupResult로 매핑.
export async function executeLookup(lookup: {
  type: LookupType
  params: { query: string }
}): Promise<LookupResult> {
  const query = lookup.params.query?.trim()
  if (!query) return { status: 'error', reason: 'empty query' }
  try {
    switch (lookup.type) {
      case 'customer_search':
        return toLookupResult('customer_search', await searchCustomers(query))
      case 'product_by_code':
        return toLookupResult('product_by_code', await searchProducts(query))
      case 'order_by_number':
        return toLookupResult('order_by_number', await searchOrders(query))
      default:
        return { status: 'error', reason: `unknown lookup type: ${(lookup as { type: string }).type}` }
    }
  } catch (err) {
    return { status: 'error', reason: (err as Error).message }
  }
}
```
> 주: 이메일 정확일치 좁히기는 `searchCustomers` 내부에 그대로 남는다(이번 변경 없음).

- [ ] **Step 2: `decideLookup` 프롬프트를 멀티 타입으로 개정**

`anthropic.messages.create({...})`의 `content` 문자열을 교체:
```ts
content: `당신은 Slack 봇의 "조회 계획" 단계다. 사용자 질문이 특정 대상을 시스템에서 조회해야 답할 수 있고, 질문에 그 대상을 찾을 검색어가 직접 들어있을 때만 조회를 계획한다.

조회 종류(type) — 셋 중 하나만:
- "customer_search": 특정 고객(회원). 검색어 = 질문에 등장한 로그인 ID(username) 또는 이메일. (이름만으로는 조회 불가 — zelda는 username만 검색, §12.1)
- "product_by_code": 특정 상품. 검색어 = 질문에 등장한 상품코드/자사상품코드(영문·숫자·하이픈 형태).
- "order_by_number": 특정 주문. 검색어 = 질문에 등장한 주문번호.

규칙:
- 반드시 JSON 객체 하나만 출력 (다른 텍스트 없이).
- 조회 필요 + 검색어 있음: {"needs_lookup": true, "lookup": {"type": "<위 셋 중 하나>", "params": {"query": "<질문에 등장한 검색어 원문>"}}}
- 그 외(일반 정책·방법 질문, 특정 대상 아님, 검색어 없음): {"needs_lookup": false}
- query는 질문에 실제로 등장한 값만 그대로 사용. 추측·생성 금지. 없으면 needs_lookup=false.
- 상품코드인지 주문번호인지는 질문의 표현("상품"/"주문")으로 판단. 모호하면 needs_lookup=false.
- type은 반드시 위 셋 중 하나의 문자열.

섹션: ${section?.name ?? '(미분류)'}
질문: ${question}`,
```

- [ ] **Step 3: `decideLookup` 의 인라인 파싱을 `parseLookupPlan` 호출로 교체**

`const raw = completion.content[0]?.type === 'text' ? completion.content[0].text : ''` 아래의 기존 파싱/검증 블록(정규식 match ~ return)을 다음으로 교체:
```ts
    const raw = completion.content[0]?.type === 'text' ? completion.content[0].text : ''
    return { plan: parseLookupPlan(raw), usage }
```

- [ ] **Step 4: 타입체크**

Run:
```bash
npx tsc --noEmit --strict --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022 --lib es2022 --types node api/_lib/lookup.ts api/_lib/zelda.ts
```
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/lookup.ts
git commit -m "feat: executeLookup 3종 디스패치 + decideLookup 멀티타입 프롬프트"
```

---

## Task 5: format.ts — 포매터 분리 + product/order 템플릿

**Files:**
- Create: `api/_lib/format.ts`
- Test: `api/_lib/format.test.ts`
- Modify: `api/slack/events.ts` (formatCustomer 제거는 Task 6에서)

- [ ] **Step 1: 실패 테스트 작성** (`format.test.ts` — sanity 교체)

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatProduct, formatOrder, formatLookupHit } from './format.js'

test('formatProduct: 코드/이름/가격/판매·전시/상태', () => {
  const s = formatProduct({ code: 'P-1', name: '신발', price: 1000, selling: true, display: false, status: 'on_sale' })
  assert.match(s, /상품 조회 결과/)
  assert.match(s, /코드: P-1/)
  assert.match(s, /판매: O \/ 전시: X/)
  assert.match(s, /상태: on_sale/)
})

test('formatOrder: 주문번호/결제완료/금액/품목상태, 고객 PII 없음', () => {
  const s = formatOrder({ code: 'O-100', ordered: '2026-05-01', paid: true, payment_amount: 5000, payment_method: 'card', item_statuses: ['shipped'] })
  assert.match(s, /주문 조회 결과/)
  assert.match(s, /주문번호: O-100/)
  assert.match(s, /결제완료: O/)
  assert.match(s, /품목상태: shipped/)
})

test('formatLookupHit: type별 포매터 선택', () => {
  assert.match(formatLookupHit('product_by_code', { code: 'P-1', name: 'n', price: 1, selling: true, display: true, status: null }), /상품 조회 결과/)
  assert.match(formatLookupHit('order_by_number', { code: 'O-1', ordered: null, paid: false, payment_amount: null, payment_method: null, item_statuses: [] }), /주문 조회 결과/)
  assert.match(formatLookupHit('customer_search', { id: 1, display_name: '홍길동', email: 'a@b.com', phone: null, status: 'unblock', blocked: false, code: 'c', created: 'd' }), /고객 조회 결과/)
})
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test`
Expected: FAIL — `./format.js` not found.

- [ ] **Step 3: `format.ts` 생성**

`events.ts`의 기존 `formatCustomer` 본문을 그대로 옮겨 온다(아래는 현행 동일 — PoC PII 전체 노출 유지). product/order/dispatch 추가:
```ts
import type { CustomerSummary, ProductSummary, OrderSummary } from './zelda.js'
import type { LookupType } from './lookup.js'

// 결정적 템플릿(D1). LLM 미통과.
// ⚠️ PoC: 고객 email/phone 등 PII를 그대로 노출. 운영 전환 시 마스킹 필요(스펙 §6).
export function formatCustomer(c: CustomerSummary): string {
  return [
    `👤 *고객 조회 결과*`,
    `• 이름: ${c.display_name}`,
    `• 이메일: ${c.email}`,
    `• 전화: ${c.phone ?? '-'}`,
    `• 코드: ${c.code}`,
    `• 상태: ${c.status}${c.blocked ? ' (차단됨)' : ''}`,
    `• 가입: ${c.created}`,
  ].join('\n')
}

export function formatProduct(p: ProductSummary): string {
  return [
    `📦 *상품 조회 결과*`,
    `• 코드: ${p.code}`,
    `• 이름: ${p.name}`,
    `• 가격: ${p.price ?? '-'}`,
    `• 판매: ${p.selling ? 'O' : 'X'} / 전시: ${p.display ? 'O' : 'X'}`,
    p.status ? `• 상태: ${p.status}` : null,
  ].filter(Boolean).join('\n')
}

// D3=A: 고객 PII 없이 주문 상태만.
export function formatOrder(o: OrderSummary): string {
  const items = o.item_statuses.length ? o.item_statuses.join(', ') : '-'
  return [
    `🧾 *주문 조회 결과*`,
    `• 주문번호: ${o.code}`,
    `• 주문일: ${o.ordered ?? '-'}`,
    `• 결제완료: ${o.paid ? 'O' : 'X'}`,
    `• 결제금액: ${o.payment_amount ?? '-'}`,
    o.payment_method ? `• 결제수단: ${o.payment_method}` : null,
    `• 품목상태: ${items}`,
  ].filter(Boolean).join('\n')
}

// hit 결과를 type에 맞는 포매터로. data ↔ type 대응은 toLookupResult가 보장.
export function formatLookupHit(
  type: LookupType,
  data: CustomerSummary | ProductSummary | OrderSummary,
): string {
  switch (type) {
    case 'product_by_code':
      return formatProduct(data as ProductSummary)
    case 'order_by_number':
      return formatOrder(data as OrderSummary)
    case 'customer_search':
      return formatCustomer(data as CustomerSummary)
  }
}
```
> 주의: `formatLookupHit`의 마지막 줄 주석 — `data as X` 캐스트는 `executeLookup`이 항상 type과 같은 종류의 data를 hit으로 만든다는 불변식에 의존한다(Task 3 `toLookupResult`).

- [ ] **Step 4: 통과 확인**

Run: `pnpm test`
Expected: PASS (format.test.ts 3 tests).

- [ ] **Step 5: Commit**

```bash
git add api/_lib/format.ts api/_lib/format.test.ts
git commit -m "feat: format.ts — formatProduct/formatOrder/formatLookupHit (+formatCustomer 이전)"
```

---

## Task 6: events.ts — hit 분기를 `formatLookupHit`로 와이어링

**Files:**
- Modify: `api/slack/events.ts`

- [ ] **Step 1: import 추가 / 정리**

상단 import 블록에 추가:
```ts
import { formatLookupHit } from '../_lib/format.js'
```
`CustomerSummary` import는 다른 곳에서 안 쓰면 제거(아래 Step 3에서 formatCustomer 삭제 후 미사용이면). 현재 `import type { CustomerSummary } from '../_lib/zelda.js'` 한 줄 — formatCustomer 삭제 후 events.ts에서 CustomerSummary 사용처가 없으면 이 import도 삭제.

- [ ] **Step 2: hit 분기 교체** (`composeReply` 내부)

기존:
```ts
      if (result.status === 'hit') {
        return `${header}\n\n${formatCustomer(result.data)}\n\n${tag}\n${formatTokenLine(usage)}`
      }
```
교체:
```ts
      if (result.status === 'hit') {
        return `${header}\n\n${formatLookupHit(result.type, result.data)}\n\n${tag}\n${formatTokenLine(usage)}`
      }
```

- [ ] **Step 3: events.ts의 기존 `formatCustomer` 함수 정의 삭제**

`function formatCustomer(c: CustomerSummary): string { … }` 블록 전체 삭제(format.ts로 이전됨). 다른 호출처가 없는지 확인:

Run: `grep -n "formatCustomer" api/slack/events.ts`
Expected: 매치 0건(삭제 후).

- [ ] **Step 4: 타입체크 (전체 api)**

Run:
```bash
npx tsc --noEmit --strict --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022 --lib es2022 --types node api/_lib/lookup.ts api/_lib/zelda.ts api/_lib/format.ts api/slack/events.ts api/_lib/db.ts api/_lib/slack-verify.ts api/sections.ts api/qa/get.ts api/qa/list.ts
```
Expected: 0 errors.

- [ ] **Step 5: 단위 테스트 재확인 + Commit**

Run: `pnpm test`
Expected: PASS (전체).
```bash
git add api/slack/events.ts
git commit -m "feat: events hit 분기를 formatLookupHit로 (product/order 응답 연결)"
```

---

## Task 7: 통합 스모크 (로컬 합성 POST) — 선택적 시드

**Files:** 없음(검증). 로컬 zelda(:8000) + chennai dev 서버 필요.

배경: 로컬 zelda에 매칭 상품/주문이 없으면 `not_found → 라우팅`(정상). 데이터가 있으면 hit 템플릿 확인.

- [ ] **Step 1: chennai dev 서버 기동**

```bash
cd /Users/hwanghyebin/conductor/workspaces/testing-slack-bot/chennai
nohup pnpm dev:api > /tmp/vercel-dev.log 2>&1 &
# "Ready! Available at http://localhost:5001" 확인
```

- [ ] **Step 2: (데이터 있으면) 실제 상품코드/주문번호 확인 — 없으면 스킵**

로컬 zelda에서 검색 가능한 상품코드 1개 확보(예: 어드민/DB). 없으면 not_found 경로만 검증.

Run (토큰은 .env.local에서):
```bash
set -a; . .env.local; set +a
curl -s -H "Authorization: Token $ZELDA_API_TOKEN" "$ZELDA_API_URL/adminapi/v1/product/?search=<상품코드>" | python3 -c "import json,sys;d=json.load(sys.stdin);print('count',len(d.get('results',[])))"
```

- [ ] **Step 3: 합성 app_mention POST (상품 조회)**

```bash
set -a; . .env.local; set +a
TS=$(date +%s); EVENT_ID="Ev_smoke_$(date +%s)"
BODY="{\"type\":\"event_callback\",\"event_id\":\"$EVENT_ID\",\"event\":{\"type\":\"app_mention\",\"channel\":\"C0B4HL61KGB\",\"user\":\"U_TESTER\",\"text\":\"<@U_BOT> 상품 <상품코드> 등록됐어?\",\"ts\":\"$TS.000300\"}}"
SIG="v0=$(printf 'v0:%s:%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SLACK_SIGNING_SECRET" | sed 's/^.* //')"
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST http://localhost:5001/api/slack/events -H "Content-Type: application/json" -H "x-slack-request-timestamp: $TS" -H "x-slack-signature: $SIG" --data "$BODY"
```
Expected: HTTP 200. 채널 `C0B4HL61KGB`에 상품 hit(있으면) 또는 "고객을 찾지 못했어요"류 라우팅(없으면) 게시.

- [ ] **Step 4: Slack에서 응답 확인**

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/conversations.history?channel=C0B4HL61KGB&limit=2" | python3 -c "import json,sys;[print(m.get('text','')[:400],'\n---') for m in json.load(sys.stdin).get('messages',[])]"
```
Expected: `📦 상품 조회 결과 …`(hit) 또는 라우팅 폴백. **로그에 PII·에러 없는지** `/tmp/vercel-dev.log` 확인.

- [ ] **Step 5: 서버 종료**

```bash
lsof -tiTCP:5001 -sTCP:LISTEN | xargs -r kill
```

---

## Task 8: 스펙 필드명 정정 + 마무리

**Files:**
- Modify: `docs/superpowers/specs/2026-06-04-part3-customer-lookup-poc-design.md`

- [ ] **Step 1: 스펙 §12.1/§12.3 OrderSummary 필드명을 실제에 맞게 정정**

§12 표/코드의 order 필드를 실제 `SimpleAdminOrderSerializer` 기준으로 수정: `OrderSummary { code, ordered, paid(bool), payment_amount, payment_method, item_statuses[] }` (= `paid_status/shipping_status/claim_status`가 아님). product는 `{ code, name, price, selling, display, status }`.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-06-04-part3-customer-lookup-poc-design.md
git commit -m "docs: 스펙 §12 order/product 실제 serializer 필드명 정정"
```

---

## Self-Review (작성자 점검 완료)

- **스펙 커버리지:** §12.1 매핑→Task1/2, §12.2 D3(order PII 제외)→Task2 테스트로 강제, §12.3 멀티타입 디스패처→Task3/4, formatProduct/Order→Task5, events 와이어링→Task6. 설정(settlement/partner·URL파싱)은 §12.4 비범위 — 계획에서도 제외(일치).
- **Placeholder:** `<상품코드>`(Task7)는 런타임 실데이터 의존이라 명시적 플레이스홀더로 표기(데이터 부재 시 not_found 경로 검증으로 대체 가능) — 코드 스텝엔 placeholder 없음.
- **타입 일관성:** `LookupType`(3종)·`LookupResult.data` union·`ProductSummary`/`OrderSummary` 필드명이 Task1~6에서 동일. `formatLookupHit(type, data)` 시그니처가 Task5 정의 = Task6 호출과 일치. `parseLookupPlan`/`toLookupResult` 추출 후 `decideLookup`/`executeLookup`이 호출(Task3 정의 → Task4 사용).
- **TDD:** 순수 함수(pick*/format*/parse*/toLookupResult)는 실패테스트 우선. 네트워크/LLM(search*/decideLookup/executeLookup)은 fetch-stub 단위테스트 + Task7 통합 스모크.
