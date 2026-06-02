import postgres from 'postgres'
import dotenv from 'dotenv'
import { readFileSync } from 'node:fs'

dotenv.config({ path: '.env.local' })

// 섹션별로 묶인 마크다운(아래 형식)을 파싱해 qa_items에 section_id 포함 bulk INSERT.
//
//   ## 섹션이름            ← sections.name 과 정확히 일치해야 함
//   ### Q: 질문 한 줄
//   답변 본문 (다음 ###/## 또는 EOF 까지, 마크다운 가능)
//
// 사용:  pnpm seed:exhibition <file.md> [--dry-run]
//   --dry-run : 파싱 결과만 출력 (DATABASE_URL 없으면 DB 접근/검증도 생략)

interface ParsedQa {
  section: string
  question: string
  answer: string
}

export function parseMarkdown(text: string): ParsedQa[] {
  const out: ParsedQa[] = []
  let section: string | null = null
  let question: string | null = null
  let answerLines: string[] = []

  const flush = () => {
    if (section && question) {
      out.push({ section, question: question.trim(), answer: answerLines.join('\n').trim() })
    }
    question = null
    answerLines = []
  }

  for (const line of text.split('\n')) {
    const qMatch = /^###\s*Q:\s*(.+?)\s*$/.exec(line)
    const secMatch = /^##\s+(.+?)\s*$/.exec(line)
    if (qMatch) {
      flush()
      question = qMatch[1]
    } else if (secMatch) {
      flush()
      section = secMatch[1].trim()
    } else if (question !== null) {
      answerLines.push(line)
    }
  }
  flush()
  return out
}

const FILE = process.argv[2]
const DRY_RUN = process.argv.includes('--dry-run')
const SEED_AUTHOR = process.env.SEED_AUTHOR_SLACK_ID ?? 'SEEDBOT'

async function main() {
  if (!FILE || FILE.startsWith('--')) {
    console.error('❌ 사용법: tsx scripts/seed-exhibition.ts <file.md> [--dry-run]')
    process.exit(1)
  }

  let text: string
  try {
    text = readFileSync(FILE, 'utf8')
  } catch {
    console.error(`❌ 파일을 읽을 수 없습니다: ${FILE}`)
    process.exit(1)
  }

  const parsed = parseMarkdown(text)
  if (parsed.length === 0) {
    console.error('❌ 파싱된 Q/A가 없습니다. "## 섹션" / "### Q: 질문" 형식을 확인하세요.')
    process.exit(1)
  }

  const sectionNames = [...new Set(parsed.map((p) => p.section))]
  console.log(`📋 ${parsed.length}건 파싱 / 섹션 ${sectionNames.length}개: ${sectionNames.join(', ')}`)
  parsed.forEach((p, i) => console.log(`  ${i + 1}. [${p.section}] ${p.question.slice(0, 50)}`))

  // dry-run인데 DB 접속정보가 없으면 파싱 검증까지만 (로컬에서 .env.local 없이도 가능)
  if (DRY_RUN && !process.env.DATABASE_URL) {
    console.log('🔎 dry-run (DATABASE_URL 미설정) — 파싱만 확인. 섹션 매핑/INSERT 생략.')
    return
  }
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL이 .env.local에 설정되어 있지 않습니다.')
    process.exit(1)
  }

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, ssl: 'require' })
  try {
    const sections = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM sections WHERE is_deleted = FALSE
    `
    const byName = new Map(sections.map((s) => [s.name, s.id]))
    const unknown = sectionNames.filter((n) => !byName.has(n))
    if (unknown.length > 0) {
      console.error(
        `❌ 미등록 섹션: ${unknown.join(', ')} — 어드민(/#/admin/sections)에서 먼저 생성하세요.`,
      )
      process.exit(1)
    }

    if (DRY_RUN) {
      console.log('🔎 dry-run — 섹션 매핑 OK. INSERT 생략.')
      return
    }

    let n = 0
    for (const p of parsed) {
      await sql`
        INSERT INTO qa_items (question, answer, author_slack_id, curator_slack_id, section_id)
        VALUES (${p.question}, ${p.answer}, ${SEED_AUTHOR}, ${SEED_AUTHOR}, ${byName.get(p.section)!})
      `
      n++
    }
    console.log(`✅ ${n}건 INSERT 완료`)
  } catch (err) {
    console.error('❌ 시드 실패:', (err as Error).message)
    process.exit(1)
  } finally {
    await sql.end()
  }
}

main()
