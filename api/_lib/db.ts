import postgres from 'postgres'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL not set')
}

export const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: 'require',
})

export interface QaItem {
  id: string
  question: string
  answer: string
  author_slack_id: string
  curator_slack_id: string
  view_count: number
  created_at: Date
  updated_at: Date
}
