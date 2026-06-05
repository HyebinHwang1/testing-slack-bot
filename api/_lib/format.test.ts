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
  assert.match(formatLookupHit('customer_search', { id: 1, display_name: '황혜빈', email: 'a@b.com', phone: null, status: 'unblock', blocked: false, code: 'c', created: 'd' }), /고객 조회 결과/)
})
