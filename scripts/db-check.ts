import postgres from 'postgres'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL이 .env.local에 설정되어 있지 않습니다.')
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: 'require',
})

async function main() {
  try {
    const result = await sql<{ id: string; question: string; created_at: Date }[]>`
      SELECT id, question, created_at
      FROM qa_items
      WHERE is_deleted = FALSE
      ORDER BY created_at DESC
      LIMIT 5
    `
    console.log('✅ DB 연결 성공')
    console.log(`📊 qa_items 조회 결과: ${result.length}건`)
    result.forEach((row, i) => {
      console.log(`  ${i + 1}. ${row.question.slice(0, 60)}`)
    })
    if (result.length === 0) {
      console.log('  (더미 데이터가 없습니다. Phase 1.2 마지막 INSERT를 다시 실행하세요.)')
    }
  } catch (err) {
    console.error('❌ DB 연결 실패:', (err as Error).message)
    process.exit(1)
  } finally {
    await sql.end()
  }
}

main()
