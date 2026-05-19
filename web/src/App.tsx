import { useEffect, useState } from 'react'

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

function App() {
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
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <h1 className="text-2xl font-bold text-slate-900">철수 Q&A</h1>
          <p className="mt-1 text-sm text-slate-500">개발팀 지식 저장소</p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8">
        {loading && (
          <div className="text-slate-500">불러오는 중...</div>
        )}

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
              <li
                key={item.id}
                className="rounded-lg bg-white border border-slate-200 p-4 hover:border-slate-300 transition-colors"
              >
                <div className="font-medium text-slate-900">{item.question}</div>
                <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
                  <span>작성: {item.author_slack_id}</span>
                  <span>·</span>
                  <span>조회 {item.view_count}회</span>
                  <span>·</span>
                  <span>{new Date(item.created_at).toLocaleDateString('ko-KR')}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

export default App
