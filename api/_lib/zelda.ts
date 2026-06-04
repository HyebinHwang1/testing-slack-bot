// 환경변수 체크는 호출 시점(zeldaFetch)에서. 모듈 로드 때 throw하면 events 엔드포인트 전체가 죽음
// (ZELDA 토큰 발급 전에도 봇의 라우팅/KB 기능은 동작해야 하므로).

// PoC: Slack 노출 필드(이메일/전화 포함, 마스킹 미적용). 운영 전환 시 마스킹/필드 제거 필수.
// pickSafeFields는 "마스킹"이 아니라 직렬화 화이트리스트(PII 포함)임에 주의.
export interface CustomerSummary {
  id: number
  display_name: string
  email: string
  phone: string | null
  status: string
  blocked: boolean
  code: string
  created: string
}

interface CustomerListResponse {
  next: string | null
  previous: string | null
  results: CustomerSummary[]
}

async function zeldaFetch<T>(path: string): Promise<T> {
  const baseUrl = process.env.ZELDA_API_URL
  const token = process.env.ZELDA_API_TOKEN
  if (!baseUrl || !token) {
    throw new Error('ZELDA_API_URL and ZELDA_API_TOKEN must be set')
  }
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Token ${token}` },
  })
  if (!res.ok) {
    throw new Error(`zelda API error: ${res.status} ${path}`)
  }
  return res.json() as Promise<T>
}

function pickSafeFields(raw: Record<string, unknown>): CustomerSummary {
  return {
    id: raw.id as number,
    display_name: raw.display_name as string,
    email: raw.email as string,
    phone: raw.phone as string | null,
    status: raw.status as string,
    blocked: raw.blocked as boolean,
    code: raw.code as string,
    created: raw.created as string,
  }
}

export async function listCustomers(): Promise<CustomerSummary[]> {
  const data = await zeldaFetch<CustomerListResponse>('/adminapi/v1/customer/')
  return data.results.map(pickSafeFields)
}

export async function getCustomer(id: number): Promise<CustomerSummary | null> {
  try {
    const raw = await zeldaFetch<Record<string, unknown>>(`/adminapi/v1/customer/${id}/`)
    return pickSafeFields(raw)
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return null
    throw err
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// 이름/이메일로 고객 검색. 서버 검색 파라미터(?search=) 사용 — 존재 여부는 착수 전 게이트(스펙 §9).
// query는 인코딩해 파라미터 인젝션 방지. 이메일이면 정확 일치만 추려 ambiguous를 줄인다.
// ⚠️ ?search= 미지원이면 첫 페이지(~50건)만 받으므로 대부분 못 찾아 not_found로 떨어진다(PoC 한계).
export async function searchCustomers(query: string): Promise<CustomerSummary[]> {
  const q = query.trim()
  if (!q) return []
  const data = await zeldaFetch<CustomerListResponse>(
    `/adminapi/v1/customer/?search=${encodeURIComponent(q)}`,
  )
  let results = data.results.map(pickSafeFields)
  if (EMAIL_RE.test(q)) {
    const exact = results.filter((c) => c.email?.toLowerCase() === q.toLowerCase())
    if (exact.length > 0) results = exact
  }
  return results
}
