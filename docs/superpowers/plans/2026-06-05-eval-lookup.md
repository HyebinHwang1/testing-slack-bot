# Eval Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `decideLookup` / `executeLookup` 정확도를 골든셋으로 자동 측정하는 eval 하네스를 만든다 — Phase B(로컬 엔티티 기반 ~26건)를 먼저 실행하고, Phase C(실제 Slack 채널 50건)로 확장한다.

**Architecture:** `scripts/golden-set-b.json`에 라벨링된 케이스를 저장, `scripts/eval-lookup.ts`가 케이스마다 `decideLookup` → (조건부) `executeLookup`을 실행해 plan/type/result 정확도를 카테고리별로 집계한다. 치명적 오답(라우팅 케이스인데 lookup 시도) 건수를 별도 집계한다.

**Tech Stack:** TypeScript (ESM, nodenext), `tsx`, `dotenv`, `decideLookup`/`executeLookup` (api/_lib/lookup.ts), zelda live API (.env.local 필요)

---

## 파일 구조

| 파일 | 책임 | 작업 |
|---|---|---|
| `scripts/golden-set-b.json` | Phase B 골든셋 26건 (라벨 포함) | **Create** |
| `scripts/eval-lookup.ts` | eval 하네스 — decideLookup/executeLookup 실행 + 채점 + 출력 | **Create** |
| `package.json` | `eval` 스크립트 추가 | Modify |

---

## Task 1: golden-set-b.json 작성

**Files:**
- Create: `scripts/golden-set-b.json`

골든셋 스키마:
```ts
type GoldenCase = {
  id: string
  input: string                  // Slack 질문 원문
  category: string               // routing | customer_lookup | product_lookup | order_lookup
  expected_needs_lookup: boolean
  expected_lookup_type?: 'customer_search' | 'product_by_code' | 'order_by_number'
  expected_query?: string        // LLM이 추출해야 하는 검색어
  expected_result_status?: 'hit' | 'not_found' | 'ambiguous'
  note?: string
}
```

케이스 구성:
- `routing` 10건: 조회 키 없는 정책/방법 질문
- `customer_lookup` 5건: "황혜빈" hit (smoke test 확인)
- `product_lookup` 5건: "JMFVFR1590" hit (smoke test 확인)
- `order_lookup` 3건: "260602-BBD90F56B" hit (smoke test 확인)
- `customer_lookup` 1건: 없는 이메일 not_found
- `product_lookup` 1건: 없는 코드 not_found
- `order_lookup` 1건: 없는 번호 not_found

- [ ] **Step 1: golden-set-b.json 생성**

```json
[
  { "id": "r-01", "input": "반품 처리는 어떻게 하나요?", "category": "routing", "expected_needs_lookup": false },
  { "id": "r-02", "input": "교환 정책이 어떻게 되나요?", "category": "routing", "expected_needs_lookup": false },
  { "id": "r-03", "input": "배송 기간이 얼마나 걸리나요?", "category": "routing", "expected_needs_lookup": false },
  { "id": "r-04", "input": "환불은 얼마나 걸리나요?", "category": "routing", "expected_needs_lookup": false },
  { "id": "r-05", "input": "고객 등급 기준이 뭔가요?", "category": "routing", "expected_needs_lookup": false },
  { "id": "r-06", "input": "결제 오류 처리 방법 알려줘", "category": "routing", "expected_needs_lookup": false },
  { "id": "r-07", "input": "쿠폰 발급 방법이 어떻게 되나요?", "category": "routing", "expected_needs_lookup": false },
  { "id": "r-08", "input": "사이즈 문의가 왔을 때 어떻게 답하나요?", "category": "routing", "expected_needs_lookup": false },
  { "id": "r-09", "input": "어드민 비밀번호 변경은 어떻게 해요?", "category": "routing", "expected_needs_lookup": false },
  { "id": "r-10", "input": "재고 관리는 어디서 하나요?", "category": "routing", "expected_needs_lookup": false },
  { "id": "c-01", "input": "황혜빈 고객 계정 상태 확인해주세요", "category": "customer_lookup", "expected_needs_lookup": true, "expected_lookup_type": "customer_search", "expected_query": "황혜빈", "expected_result_status": "hit", "note": "smoke test 확인" },
  { "id": "c-02", "input": "황혜빈님 blocked 여부 알려줘", "category": "customer_lookup", "expected_needs_lookup": true, "expected_lookup_type": "customer_search", "expected_query": "황혜빈", "expected_result_status": "hit" },
  { "id": "c-03", "input": "황혜빈 회원 정보 조회해줘", "category": "customer_lookup", "expected_needs_lookup": true, "expected_lookup_type": "customer_search", "expected_query": "황혜빈", "expected_result_status": "hit" },
  { "id": "c-04", "input": "황혜빈 고객 주문 가능 상태인가요?", "category": "customer_lookup", "expected_needs_lookup": true, "expected_lookup_type": "customer_search", "expected_query": "황혜빈", "expected_result_status": "hit" },
  { "id": "c-05", "input": "황혜빈이라는 고객이 있는지 확인해줘", "category": "customer_lookup", "expected_needs_lookup": true, "expected_lookup_type": "customer_search", "expected_query": "황혜빈", "expected_result_status": "hit" },
  { "id": "p-01", "input": "JMFVFR1590 상품 판매 상태 알려줘", "category": "product_lookup", "expected_needs_lookup": true, "expected_lookup_type": "product_by_code", "expected_query": "JMFVFR1590", "expected_result_status": "hit", "note": "smoke test 확인" },
  { "id": "p-02", "input": "상품코드 JMFVFR1590 전시 여부 확인해줘", "category": "product_lookup", "expected_needs_lookup": true, "expected_lookup_type": "product_by_code", "expected_query": "JMFVFR1590", "expected_result_status": "hit" },
  { "id": "p-03", "input": "JMFVFR1590 가격 얼마예요?", "category": "product_lookup", "expected_needs_lookup": true, "expected_lookup_type": "product_by_code", "expected_query": "JMFVFR1590", "expected_result_status": "hit" },
  { "id": "p-04", "input": "JMFVFR1590 판매 중인가요?", "category": "product_lookup", "expected_needs_lookup": true, "expected_lookup_type": "product_by_code", "expected_query": "JMFVFR1590", "expected_result_status": "hit" },
  { "id": "p-05", "input": "상품 JMFVFR1590 정보 알려줘", "category": "product_lookup", "expected_needs_lookup": true, "expected_lookup_type": "product_by_code", "expected_query": "JMFVFR1590", "expected_result_status": "hit" },
  { "id": "o-01", "input": "주문번호 260602-BBD90F56B 결제 확인해줘", "category": "order_lookup", "expected_needs_lookup": true, "expected_lookup_type": "order_by_number", "expected_query": "260602-BBD90F56B", "expected_result_status": "hit", "note": "smoke test 확인" },
  { "id": "o-02", "input": "260602-BBD90F56B 주문 상태 어때요?", "category": "order_lookup", "expected_needs_lookup": true, "expected_lookup_type": "order_by_number", "expected_query": "260602-BBD90F56B", "expected_result_status": "hit" },
  { "id": "o-03", "input": "260602-BBD90F56B 배송 어디까지 갔어요?", "category": "order_lookup", "expected_needs_lookup": true, "expected_lookup_type": "order_by_number", "expected_query": "260602-BBD90F56B", "expected_result_status": "hit" },
  { "id": "c-nf-01", "input": "nobody@notexist.example.com 고객 조회해줘", "category": "customer_lookup", "expected_needs_lookup": true, "expected_lookup_type": "customer_search", "expected_query": "nobody@notexist.example.com", "expected_result_status": "not_found" },
  { "id": "p-nf-01", "input": "ZZZNOTEXIST99 상품 정보 알려줘", "category": "product_lookup", "expected_needs_lookup": true, "expected_lookup_type": "product_by_code", "expected_query": "ZZZNOTEXIST99", "expected_result_status": "not_found" },
  { "id": "o-nf-01", "input": "주문번호 000000-ZZZZFAKE 확인해줘", "category": "order_lookup", "expected_needs_lookup": true, "expected_lookup_type": "order_by_number", "expected_query": "000000-ZZZZFAKE", "expected_result_status": "not_found" }
]
```

- [ ] **Step 2: 케이스 수 확인**

```bash
node -e "const d=require('./scripts/golden-set-b.json'); console.log(d.length, 'cases')"
```
기대: `26 cases`

---

## Task 2: eval-lookup.ts 구현

**Files:**
- Create: `scripts/eval-lookup.ts`

- [ ] **Step 1: eval-lookup.ts 작성**

```ts
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decideLookup, executeLookup, type LookupType } from '../api/_lib/lookup.js'

// dotenv/config은 .env를 로드함. .env.local은 수동 로드
import { existsSync } from 'node:fs'
const envPath = join(process.cwd(), '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/)
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim()
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))

interface GoldenCase {
  id: string
  input: string
  category: string
  expected_needs_lookup: boolean
  expected_lookup_type?: LookupType
  expected_query?: string
  expected_result_status?: 'hit' | 'not_found' | 'ambiguous'
  note?: string
}

interface CaseResult {
  id: string
  input: string
  category: string
  plan_correct: boolean
  type_correct: boolean | null
  query_match: boolean | null
  result_correct: boolean | null
  fatal: boolean
  actual_needs_lookup: boolean
  actual_type?: string
  actual_query?: string
  actual_result_status?: string
  usage: { input: number; output: number }
  error?: string
}

async function runEval(goldenPath: string): Promise<void> {
  const cases: GoldenCase[] = JSON.parse(readFileSync(goldenPath, 'utf8'))
  const results: CaseResult[] = []
  let totalInput = 0, totalOutput = 0

  console.log(`\n=== Phase B Eval — ${cases.length}건 ===\n`)

  for (const c of cases) {
    process.stdout.write(`[${c.id}] ${c.input.slice(0, 45).padEnd(45)} `)
    try {
      const { plan, usage } = await decideLookup(c.input, null)
      totalInput += usage.input
      totalOutput += usage.output

      const planCorrect = plan.needs_lookup === c.expected_needs_lookup
      const fatal = !c.expected_needs_lookup && plan.needs_lookup

      let typeCorrect: boolean | null = null
      let queryMatch: boolean | null = null
      let resultCorrect: boolean | null = null
      let actualType: string | undefined
      let actualQuery: string | undefined
      let actualResultStatus: string | undefined

      if (plan.needs_lookup) {
        actualType = plan.lookup.type
        actualQuery = plan.lookup.params.query
        if (c.expected_needs_lookup) {
          typeCorrect = plan.lookup.type === c.expected_lookup_type
          queryMatch = c.expected_query
            ? plan.lookup.params.query.trim().toLowerCase().includes(c.expected_query.toLowerCase())
            : null
          const execResult = await executeLookup(plan.lookup)
          actualResultStatus = execResult.status
          if (c.expected_result_status) {
            resultCorrect = execResult.status === c.expected_result_status
          }
        }
      }

      const allOk = planCorrect && (typeCorrect ?? true) && (resultCorrect ?? true) && (queryMatch ?? true)
      const mark = fatal ? '🚨' : allOk ? '✅' : '❌'
      const detail = fatal
        ? `(false-positive: ${plan.lookup.type}?${plan.lookup.params.query})`
        : !planCorrect
          ? `(plan: expected ${c.expected_needs_lookup})`
          : typeCorrect === false
            ? `(type: expected ${c.expected_lookup_type} got ${actualType})`
            : resultCorrect === false
              ? `(result: expected ${c.expected_result_status} got ${actualResultStatus})`
              : queryMatch === false
                ? `(query: expected ${c.expected_query} got ${actualQuery})`
                : ''
      console.log(`${mark} ${detail}`)

      results.push({
        id: c.id, input: c.input, category: c.category,
        plan_correct: planCorrect, type_correct: typeCorrect, query_match: queryMatch,
        result_correct: resultCorrect, fatal,
        actual_needs_lookup: plan.needs_lookup, actual_type: actualType,
        actual_query: actualQuery, actual_result_status: actualResultStatus, usage,
      })
    } catch (err) {
      console.log(`💥 ${(err as Error).message}`)
      results.push({
        id: c.id, input: c.input, category: c.category,
        plan_correct: false, type_correct: null, query_match: null, result_correct: null,
        fatal: false, actual_needs_lookup: false,
        usage: { input: 0, output: 0 }, error: (err as Error).message,
      })
    }
  }

  // 카테고리별 집계
  const categories = [...new Set(results.map(r => r.category))]
  console.log('\n' + '─'.repeat(82))
  console.log(`${'카테고리'.padEnd(18)} ${'N'.padEnd(4)} ${'plan정확도'.padEnd(16)} ${'type정확도'.padEnd(16)} ${'result정확도'.padEnd(16)}`)
  console.log('─'.repeat(82))

  for (const cat of categories) {
    const cr = results.filter(r => r.category === cat)
    const n = cr.length
    const planOk = cr.filter(r => r.plan_correct).length
    const typeN = cr.filter(r => r.type_correct !== null).length
    const typeOk = cr.filter(r => r.type_correct === true).length
    const resN = cr.filter(r => r.result_correct !== null).length
    const resOk = cr.filter(r => r.result_correct === true).length
    const pStr = `${planOk}/${n} (${Math.round(planOk/n*100)}%)`
    const tStr = typeN > 0 ? `${typeOk}/${typeN} (${Math.round(typeOk/typeN*100)}%)` : '-'
    const rStr = resN > 0 ? `${resOk}/${resN} (${Math.round(resOk/resN*100)}%)` : '-'
    console.log(`${cat.padEnd(18)} ${String(n).padEnd(4)} ${pStr.padEnd(16)} ${tStr.padEnd(16)} ${rStr.padEnd(16)}`)
  }

  console.log('─'.repeat(82))
  const totalPlanOk = results.filter(r => r.plan_correct).length
  const fatalCount = results.filter(r => r.fatal).length
  console.log(`\n총 plan 정확도: ${totalPlanOk}/${results.length} (${Math.round(totalPlanOk/results.length*100)}%)`)
  console.log(`치명적 오답(false positive): ${fatalCount}건`)
  console.log(`총 토큰: input=${totalInput.toLocaleString()} output=${totalOutput.toLocaleString()}`)

  const outPath = join(__dirname, 'eval-result-b.json')
  writeFileSync(outPath, JSON.stringify({
    summary: { total: results.length, plan_ok: totalPlanOk, fatal: fatalCount, tokens: { input: totalInput, output: totalOutput } },
    results,
  }, null, 2))
  console.log(`\n결과 저장: ${outPath}`)
}

runEval(join(__dirname, 'golden-set-b.json')).catch(console.error)
```

- [ ] **Step 2: package.json에 eval 스크립트 추가**

`scripts` 블록에 추가:
```json
"eval": "tsx scripts/eval-lookup.ts"
```

- [ ] **Step 3: eval 실행**

```bash
pnpm eval
```

기대 출력: 카테고리별 정확도 표 + `eval-result-b.json` 생성

---

## Task 3: Phase C — 실제 Slack 채널 50건 추출 (후속)

**Files:**
- Create: `scripts/golden-set-c.json`

- [ ] **Step 1: Slack MCP로 채널 메시지 추출**

Slack MCP `slack_read_channel`로 `SLACK_TARGET_CHANNEL_ID=C0B4HL61KGB` 최근 메시지 읽기.
질문 형태의 메시지를 50건 수동 선별 + 카테고리 라벨링(routing / customer_lookup / product_lookup / order_lookup).

- [ ] **Step 2: 조회 케이스 키치환**

실제 Slack 질문에 등장하는 주문번호/상품코드/고객이름이 로컬 zelda에 없을 수 있음.
있는 키는 그대로, 없는 키는 로컬 실재 엔티티(황혜빈/JMFVFR1590/260602-BBD90F56B)로 치환.
`expected_result_status`는 치환 후 실제 API 결과로 확정.

- [ ] **Step 3: eval 재실행**

```bash
pnpm eval:c  # golden-set-c.json 대상
```
