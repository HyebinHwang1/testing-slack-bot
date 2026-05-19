import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql, type QaItem } from '../_lib/db.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const items = await sql<QaItem[]>`
      SELECT id, question, answer, author_slack_id, curator_slack_id,
             view_count, created_at, updated_at
      FROM qa_items
      WHERE is_deleted = FALSE
      ORDER BY created_at DESC
      LIMIT 100
    `
    return res.status(200).json({ items })
  } catch (err) {
    console.error('GET /api/qa/list error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
