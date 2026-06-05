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
  assert.equal((out[0] as Record<string, unknown>).supply_name, undefined)
})
