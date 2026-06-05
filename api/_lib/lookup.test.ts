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
