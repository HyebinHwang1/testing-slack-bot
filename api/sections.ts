import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sql, type Section } from './_lib/db.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    switch (req.method) {
      case 'GET':
        return await listSections(res)
      case 'POST':
        return await createSection(req, res)
      case 'PUT':
        return await updateSection(req, res)
      case 'DELETE':
        return await deleteSection(req, res)
      default:
        return res.status(405).json({ error: 'Method not allowed' })
    }
  } catch (err) {
    console.error(`${req.method} /api/sections error:`, err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

async function listSections(res: VercelResponse) {
  const sections = await sql<Section[]>`
    SELECT id, name, description, curator_slack_id, curator_name,
           is_deleted, created_at, updated_at
    FROM sections
    WHERE is_deleted = FALSE
    ORDER BY created_at DESC
  `
  return res.status(200).json({ sections })
}

async function createSection(req: VercelRequest, res: VercelResponse) {
  const { name, description, curator_slack_id, curator_name } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' })
  }
  const rows = await sql<Section[]>`
    INSERT INTO sections (name, description, curator_slack_id, curator_name)
    VALUES (
      ${name.trim()},
      ${description ?? null},
      ${curator_slack_id ?? null},
      ${curator_name ?? null}
    )
    RETURNING id, name, description, curator_slack_id, curator_name,
              is_deleted, created_at, updated_at
  `
  return res.status(201).json({ section: rows[0] })
}

async function updateSection(req: VercelRequest, res: VercelResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid id' })
  }
  const { name, description, curator_slack_id, curator_name } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' })
  }
  const rows = await sql<Section[]>`
    UPDATE sections
    SET name = ${name.trim()},
        description = ${description ?? null},
        curator_slack_id = ${curator_slack_id ?? null},
        curator_name = ${curator_name ?? null},
        updated_at = now()
    WHERE id = ${id} AND is_deleted = FALSE
    RETURNING id, name, description, curator_slack_id, curator_name,
              is_deleted, created_at, updated_at
  `
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Not found' })
  }
  return res.status(200).json({ section: rows[0] })
}

async function deleteSection(req: VercelRequest, res: VercelResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid id' })
  }
  const rows = await sql<{ id: string }[]>`
    UPDATE sections
    SET is_deleted = TRUE, updated_at = now()
    WHERE id = ${id} AND is_deleted = FALSE
    RETURNING id
  `
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Not found' })
  }
  return res.status(200).json({ ok: true })
}
