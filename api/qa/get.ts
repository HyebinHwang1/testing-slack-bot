import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql, type QaItem } from '../_lib/db.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const id = typeof req.query.id === 'string' ? req.query.id : ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid id' })
  }

  try {
    const rows = await sql<QaItem[]>`
      UPDATE qa_items
      SET view_count = view_count + 1
      WHERE id = ${id} AND is_deleted = FALSE
      RETURNING id, question, answer, author_slack_id, curator_slack_id,
                view_count, created_at, updated_at
    `
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Not found' })
    }
    return res.status(200).json({ item: rows[0] })
  } catch (err) {
    console.error('GET /api/qa/get error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
