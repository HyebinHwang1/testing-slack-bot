import Anthropic from '@anthropic-ai/sdk'
import { type Section } from './db.js'
import { searchCustomers, searchProducts, searchOrders, type CustomerSummary, type ProductSummary, type OrderSummary } from './zelda.js'

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'

export type TokenUsage = { input: number; output: number }

// 조회 종류 화이트리스트
export type LookupType = 'customer_search' | 'product_by_code' | 'order_by_number'
const LOOKUP_TYPES: LookupType[] = ['customer_search', 'product_by_code', 'order_by_number']

// needs_lookup=true인데 lookup=null인 모순 상태를 타입으로 차단 (discriminated union)
export type LookupPlan =
  | { needs_lookup: false }
  | { needs_lookup: true; lookup: { type: LookupType; params: { query: string } } }

export type LookupResult =
  | { status: 'hit'; type: LookupType; data: CustomerSummary | ProductSummary | OrderSummary }
  | { status: 'not_found' }
  | { status: 'ambiguous'; count: number } // 2건 이상 — PII 덤프 회피, 이름/이메일 미포함
  | { status: 'error'; reason: string }

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

// ① 계획 — "조회가 필요한가? 필요하면 어떤 종류·검색어인가"를 LLM이 판단 (classifySection과 직교)
export async function decideLookup(
  question: string,
  section: Section | null,
): Promise<{ plan: LookupPlan; usage: TokenUsage }> {
  const zero: TokenUsage = { input: 0, output: 0 }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 })
  try {
    const completion = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: `당신은 Slack 봇의 "조회 계획" 단계다. 사용자 질문이 특정 대상을 시스템에서 조회해야 답할 수 있고, 질문에 그 대상을 찾을 검색어가 직접 들어있을 때만 조회를 계획한다.

조회 종류(type) — 셋 중 하나만:
- "customer_search": 특정 고객(회원). 검색어 = 질문에 등장한 로그인 ID(username) 또는 이메일. (이름만으로는 조회 불가 — 사람 이름만 있고 ID/이메일이 없으면 needs_lookup=false)
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
        },
      ],
    })
    const usage: TokenUsage = {
      input: completion.usage.input_tokens,
      output: completion.usage.output_tokens,
    }
    const raw = completion.content[0]?.type === 'text' ? completion.content[0].text : ''
    return { plan: parseLookupPlan(raw), usage }
  } catch (err) {
    console.error('decideLookup error:', err)
    return { plan: { needs_lookup: false }, usage: zero }
  }
}

// ② 실행 — 계획을 코드가 결정적으로 디스패치. type별 search 호출 후 toLookupResult로 매핑.
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
