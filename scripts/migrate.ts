import postgres from 'postgres'
import dotenv from 'dotenv'
import { readFileSync } from 'node:fs'

dotenv.config({ path: '.env.local' })

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL이 .env.local에 설정되어 있지 않습니다.')
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: 'require',
})

// qa_items.section_id 마이그레이션 적용 + 검증. 멱등이라 재실행 안전.
async function main() {
  try {
    const ddl = readFileSync('scripts/qa-section-id-schema.sql', 'utf8')
    await sql.unsafe(ddl) // 멀티 스테이트먼트 DDL → 태그드 템플릿 대신 unsafe (정적 레포 파일)
    console.log('✅ 마이그레이션 적용 완료')

    const cols = await sql<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'qa_items' AND column_name = 'section_id'
    `
    if (cols.length === 0) {
      console.error('❌ 검증 실패: section_id 컬럼이 없습니다.')
      process.exit(1)
    }
    console.log(`📋 section_id: ${cols[0].data_type}, nullable=${cols[0].is_nullable}`)
  } catch (err) {
    console.error('❌ 마이그레이션 실패:', (err as Error).message)
    process.exit(1)
  } finally {
    await sql.end()
  }
}

main()
