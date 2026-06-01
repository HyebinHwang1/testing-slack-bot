import { useEffect, useState, type FormEvent } from 'react'
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

type Route =
  | { view: 'list' }
  | { view: 'detail'; id: string }
  | { view: 'admin' }

function useHashRoute(): Route {
  const [hash, setHash] = useState<string>(() => window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  if (hash === '#/admin/sections') return { view: 'admin' }
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

interface Section {
  id: string
  name: string
  description: string | null
  curator_slack_id: string | null
  curator_name: string | null
  created_at: string
  updated_at: string
}

const EMPTY_FORM = { name: '', description: '', curator_slack_id: '', curator_name: '' }

function SectionsAdminPage() {
  const [sections, setSections] = useState<Section[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    fetch('/api/sections')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: { sections: Section[] }) => {
        setSections(data.sections)
        setError(null)
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const resetForm = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  const startEdit = (s: Section) => {
    setEditingId(s.id)
    setForm({
      name: s.name,
      description: s.description ?? '',
      curator_slack_id: s.curator_slack_id ?? '',
      curator_name: s.curator_name ?? '',
    })
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    try {
      const url = editingId ? `/api/sections?id=${editingId}` : '/api/sections'
      const r = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      resetForm()
      load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    if (!window.confirm('이 섹션을 삭제할까요?')) return
    try {
      const r = await fetch(`/api/sections?id=${id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      if (editingId === id) resetForm()
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <main className="max-w-3xl mx-auto px-6 py-8">
      <a
        href="#/"
        className="inline-flex items-center text-sm text-slate-500 hover:text-slate-900 mb-6"
      >
        ← 목록으로
      </a>

      <form onSubmit={submit} className="rounded-lg bg-white border border-slate-200 p-6 mb-6">
        <h2 className="text-lg font-bold text-slate-900 mb-4">
          {editingId ? '섹션 수정' : '섹션 추가'}
        </h2>
        <div className="space-y-3">
          <input
            className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            placeholder="섹션명 (예: 결제, 배송, 상품)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <textarea
            className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            placeholder="설명 (분류 정확도를 위해 어떤 문의가 이 섹션인지 적어주세요)"
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <div className="flex gap-3">
            <input
              className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
              placeholder="담당자 Slack ID (예: U12345ABC)"
              value={form.curator_slack_id}
              onChange={(e) => setForm({ ...form, curator_slack_id: e.target.value })}
            />
            <input
              className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
              placeholder="담당자 이름 (표시용)"
              value={form.curator_name}
              onChange={(e) => setForm({ ...form, curator_name: e.target.value })}
            />
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            type="submit"
            disabled={saving || !form.name.trim()}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
          >
            {saving ? '저장 중...' : editingId ? '수정' : '추가'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              취소
            </button>
          )}
        </div>
      </form>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800 mb-4">
          오류: {error}
        </div>
      )}

      {loading && <div className="text-slate-500">불러오는 중...</div>}

      {!loading && sections.length === 0 && (
        <div className="text-slate-500">아직 등록된 섹션이 없어요.</div>
      )}

      {!loading && sections.length > 0 && (
        <ul className="space-y-3">
          {sections.map((s) => (
            <li
              key={s.id}
              className="rounded-lg bg-white border border-slate-200 p-4 flex items-start justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="font-medium text-slate-900">{s.name}</div>
                {s.description && (
                  <div className="mt-1 text-sm text-slate-500">{s.description}</div>
                )}
                <div className="mt-2 text-xs text-slate-500">
                  담당자:{' '}
                  {s.curator_slack_id
                    ? `${s.curator_name ? `${s.curator_name} ` : ''}(${s.curator_slack_id})`
                    : '미지정'}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => startEdit(s)}
                  className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                >
                  수정
                </button>
                <button
                  onClick={() => remove(s.id)}
                  className="rounded border border-red-200 px-3 py-1 text-xs text-red-600 hover:bg-red-50"
                >
                  삭제
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

function App() {
  const route = useHashRoute()

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-6 py-6 flex items-end justify-between">
          <a href="#/" className="inline-block">
            <h1 className="text-2xl font-bold text-slate-900">철수 Q&A</h1>
            <p className="mt-1 text-sm text-slate-500">개발팀 지식 저장소</p>
          </a>
          <a
            href="#/admin/sections"
            className="text-sm text-slate-500 hover:text-slate-900"
          >
            섹션 관리
          </a>
        </div>
      </header>

      {route.view === 'admin' ? (
        <SectionsAdminPage />
      ) : route.view === 'detail' ? (
        <DetailPage id={route.id} />
      ) : (
        <ListPage />
      )}
    </div>
  )
}

export default App
