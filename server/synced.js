// Synchronisierte Blöcke: ein Inhalt, der in mehreren Dokumenten über `::synced {"id":"…"}` eingebunden wird.
// Änderungen wirken sofort überall, wo der Block verwendet wird.
import { Router } from 'express';
import { db, tx } from './db.js';
import { HttpError, randomToken } from './security.js';
import { requireRole, audit } from './auth.js';
import { normContent } from './routes/docs.js';

export const SYNCED_REF = /^::synced\s+\{\s*"id"\s*:\s*"([A-Za-z0-9_-]{8,40})"/gm;
export function syncedRefs(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(SYNCED_REF)) out.add(m[1]);
  return out;
}

const dto = r => ({ id: r.id, content: r.content, version: r.version, updated: r.updated_at, updatedBy: r.updated_by_name ?? null });
const SELECT = 'SELECT s.*, u.display_name AS updated_by_name FROM synced_blocks s LEFT JOIN users u ON u.id = s.updated_by';

export function getSynced(ids) {
  const out = {};
  for (const id of ids) {
    const r = db.prepare('SELECT id, content FROM synced_blocks WHERE id = ?').get(id);
    if (r) out[r.id] = r.content;
  }
  return out;
}

// Nicht mehr verwendete Blöcke nach 30 Tagen entfernen (Versionen zählen als Verwendung).
export function cleanupSynced() {
  const rows = db.prepare('SELECT id FROM synced_blocks WHERE updated_at < ?').all(Date.now() - 30 * 86400000);
  if (!rows.length) return 0;
  const used = new Set();
  for (const r of db.prepare('SELECT content FROM documents').iterate()) syncedRefs(r.content).forEach(x => used.add(x));
  for (const r of db.prepare('SELECT content FROM revisions').iterate()) syncedRefs(r.content).forEach(x => used.add(x));
  let n = 0;
  for (const r of rows) if (!used.has(r.id)) { db.prepare('DELETE FROM synced_blocks WHERE id = ?').run(r.id); n++; }
  return n;
}

export const syncedApi = Router();
const editor = requireRole('editor');

syncedApi.get('/', (req, res) => {
  res.json({ blocks: db.prepare(`${SELECT} ORDER BY s.updated_at DESC`).all().map(dto) });
});

syncedApi.post('/', editor, (req, res) => {
  const content = normContent(req.body?.content ?? '');
  if (syncedRefs(content).size) throw new HttpError(400, 'Synchronisierte Blöcke können nicht verschachtelt werden.');
  const id = 'sb_' + randomToken(12);
  const now = Date.now();
  db.prepare('INSERT INTO synced_blocks (id, content, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, content, req.user.id, now, req.user.id, now);
  audit(req, 'synced.created', id);
  res.status(201).json({ block: dto(db.prepare(`${SELECT} WHERE s.id = ?`).get(id)) });
});

syncedApi.put('/:id', editor, (req, res) => {
  const block = tx(() => {
    const cur = db.prepare('SELECT * FROM synced_blocks WHERE id = ?').get(String(req.params.id));
    if (!cur) throw new HttpError(404, 'Block nicht gefunden.');
    if (req.body?.version !== undefined && Number(req.body.version) !== cur.version) {
      throw new HttpError(409, 'Der Block wurde inzwischen an anderer Stelle geändert.', { block: dto(db.prepare(`${SELECT} WHERE s.id = ?`).get(cur.id)) });
    }
    const content = normContent(req.body?.content ?? '');
    if (syncedRefs(content).size) throw new HttpError(400, 'Synchronisierte Blöcke können nicht verschachtelt werden.');
    if (content !== cur.content) {
      db.prepare('UPDATE synced_blocks SET content = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(content, req.user.id, Date.now(), cur.id);
    }
    return dto(db.prepare(`${SELECT} WHERE s.id = ?`).get(cur.id));
  });
  res.json({ block });
});
