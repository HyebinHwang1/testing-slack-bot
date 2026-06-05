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

// hit 결과를 type에 맞는 포매터로. data ↔ type 대응은 toLookupResult(lookup.ts)가 보장.
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
