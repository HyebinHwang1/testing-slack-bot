import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { searchProducts, searchOrders } from './zelda.js'

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
  assert.equal((out[0] as Record<string, unknown>).supply_name, undefined)
})

test('searchOrders: 상태 필드만, 고객 PII는 제외(D3)', async () => {
  process.env.ZELDA_API_URL = 'http://localhost:8000'
  process.env.ZELDA_API_TOKEN = 't'
  const calls = stubFetch({
    next: null, previous: null,
    results: [{
      id: 9, code: 'O-100', ordered: '2026-05-01T10:00:00+09:00',
      paid: true, payment_amount: 5000, payment_method: 'card',
      orderitem_set: [{ status: 'shipped' }, { status: 'delivered' }],
      customer_name: '홍길동',
      customer_object: { first_name: '길동', last_name: '홍' },
      customer_email: 'x@y.com', customer_phone: '010-0000-0000',
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
