import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'

interface QaItem {
  id: string
  question: string
  answer: string
  author_slack_id: string
  curator_slack_id: string
  view_count: number
  created_at: string
  updated_at: string
}

function useHashRoute(): { view: 'list'; id?: undefined } | { view: 'detail'; id: string } {
  const [hash, setHash] = useState<string>(() => window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const m = hash.match(/^#\/qa\/([0-9a-f-]{36})$/i)
  return m ? { view: 'detail', id: m[1] } : { view: 'list' }
}

function ListPage() {
  const [items, setItems] = useState<QaItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/qa/list')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: { items: QaItem[] }) => {
        setItems(data.items)
        setLoading(false)
      })
      .catch((err: Error) => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  return (
    <main className="max-w-3xl mx-auto px-6 py-8">
      {loading && <div className="text-slate-500">불러오는 중...</div>}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          오류: {error}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="text-slate-500">아직 저장된 Q&A가 없어요.</div>
      )}

      {!loading && !error && items.length > 0 && (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id}>
              <a
                href={`#/qa/${item.id}`}
                className="block rounded-lg bg-white border border-slate-200 p-4 hover:border-slate-400 hover:shadow-sm transition-all"
              >
                <div className="font-medium text-slate-900">{item.question}</div>
                <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
                  <span>작성: {item.author_slack_id}</span>
                  <span>·</span>
                  <span>조회 {item.view_count}회</span>
                  <span>·</span>
                  <span>{new Date(item.created_at).toLocaleDateString('ko-KR')}</span>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

function DetailPage({ id }: { id: string }) {
  const [item, setItem] = useState<QaItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/qa/get?id=${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (r.status === 404) throw new Error('해당 Q&A를 찾을 수 없어요.')
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: { item: QaItem }) => {
        setItem(data.item)
        setLoading(false)
      })
      .catch((err: Error) => {
        setError(err.message)
        setLoading(false)
      })
  }, [id])

  return (
    <main className="max-w-3xl mx-auto px-6 py-8">
      <a
        href="#/"
        className="inline-flex items-center text-sm text-slate-500 hover:text-slate-900 mb-6"
      >
        ← 목록으로
      </a>

      {loading && <div className="text-slate-500">불러오는 중...</div>}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {!loading && !error && item && (
        <article className="rounded-lg bg-white border border-slate-200 p-6">
          <h2 className="text-xl font-bold text-slate-900">{item.question}</h2>
          <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
            <span>작성: {item.author_slack_id}</span>
            <span>·</span>
            <span>조회 {item.view_count}회</span>
            <span>·</span>
            <span>{new Date(item.created_at).toLocaleString('ko-KR')}</span>
          </div>

          <div className="mt-6 prose prose-slate prose-sm max-w-none prose-pre:bg-slate-900 prose-pre:text-slate-100">
            <ReactMarkdown>{item.answer}</ReactMarkdown>
          </div>
        </article>
      )}
    </main>
  )
}

function App() {
  const route = useHashRoute()

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <a href="#/" className="inline-block">
            <h1 className="text-2xl font-bold text-slate-900">철수 Q&A</h1>
            <p className="mt-1 text-sm text-slate-500">개발팀 지식 저장소</p>
          </a>
        </div>
      </header>

      {route.view === 'detail' ? <DetailPage id={route.id} /> : <ListPage />}
    </div>
  )
}

export default App
