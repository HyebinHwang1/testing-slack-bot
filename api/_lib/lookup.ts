import Anthropic from '@anthropic-ai/sdk'
import { type Section } from './db.js'
import { searchCustomers, type CustomerSummary } from './zelda.js'

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'

export type TokenUsage = { input: number; output: number }

// 조회 종류 화이트리스트. 확장: 'product_by_code' | 'order_by_number' ...
export type LookupType = 'customer_search'
const LOOKUP_TYPES: LookupType[] = ['customer_search']

// needs_lookup=true인데 lookup=null인 모순 상태를 타입으로 차단 (discriminated union)
export type LookupPlan =
  | { needs_lookup: false }
  | { needs_lookup: true; lookup: { type: LookupType; params: { query: string } } }

export type LookupResult =
  | { status: 'hit'; type: LookupType; data: CustomerSummary }
  | { status: 'not_found' }
  | { status: 'ambiguous'; count: number } // 2건 이상 — PII 덤프 회피, 이름/이메일 미포함
  | { status: 'error'; reason: string }

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
          content: `당신은 Slack 봇의 "조회 계획" 단계다. 사용자 질문이 특정 고객(회원)을 시스템에서 조회해야 답할 수 있고, 질문에 그 고객을 찾을 검색어(이메일 또는 사람 이름)가 직접 들어있을 때만 조회를 계획한다.

규칙:
- 반드시 JSON 객체 하나만 출력 (다른 텍스트 없이).
- 조회 필요 + 검색어 있음: {"needs_lookup": true, "lookup": {"type": "customer_search", "params": {"query": "<질문에 등장한 이메일 또는 이름>"}}}
- 그 외(일반 정책·방법 질문, 특정 고객이 아님, 검색어 없음): {"needs_lookup": false}
- query는 질문에 실제로 등장한 이메일 주소 또는 사람 이름만 그대로 사용. 추측·생성 금지. 없으면 needs_lookup=false.
- type은 반드시 "customer_search".

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
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return { plan: { needs_lookup: false }, usage }

    const parsed = JSON.parse(match[0]) as {
      needs_lookup?: boolean
      lookup?: { type?: string; params?: { query?: string } }
    }
    const type = parsed.lookup?.type
    const query = typeof parsed.lookup?.params?.query === 'string' ? parsed.lookup.params.query.trim() : ''
    if (!parsed.needs_lookup || !type || !LOOKUP_TYPES.includes(type as LookupType) || !query) {
      return { plan: { needs_lookup: false }, usage }
    }
    return { plan: { needs_lookup: true, lookup: { type: type as LookupType, params: { query } } }, usage }
  } catch (err) {
    console.error('decideLookup error:', err)
    return { plan: { needs_lookup: false }, usage: zero }
  }
}

// ② 실행 — 계획을 코드가 결정적으로 디스패치. type별 params 검증 후에만 실제 호출.
export async function executeLookup(lookup: {
  type: LookupType
  params: { query: string }
}): Promise<LookupResult> {
  try {
    switch (lookup.type) {
      case 'customer_search': {
        const query = lookup.params.query?.trim()
        if (!query) return { status: 'error', reason: 'empty query' }
        const results = await searchCustomers(query)
        if (results.length === 0) return { status: 'not_found' }
        if (results.length >= 2) return { status: 'ambiguous', count: results.length }
        return { status: 'hit', type: 'customer_search', data: results[0] }
      }
      default:
        return { status: 'error', reason: `unknown lookup type: ${(lookup as { type: string }).type}` }
    }
  } catch (err) {
    return { status: 'error', reason: (err as Error).message }
  }
}
