import { Router } from 'express';
import { config } from '../config.js';
import { HttpError, RateLimiter } from '../security.js';
import { audit, clientIp } from '../auth.js';
import { db } from '../db.js';
import { createShare, listShares, revokeShare, resolvePublic, getShareSettings, mayShare, shareStatus } from '../shares.js';

// ---------- Angemeldete Benutzer ----------
export const shareRoutes = Router();

shareRoutes.get('/', (req, res) => res.json({ shares: listShares({ userId: req.user.id, includeInactive: true }).filter(s => !s.revoked) }));

// Freigaben eines Elements (eigene; Admins sehen alle) + ob es geteilt werden darf
shareRoutes.get('/item', (req, res) => {
  const kind = req.query.kind === 'folder' ? 'folder' : 'doc';
  const id = String(req.query.id || '');
  const target = kind === 'doc'
    ? db.prepare('SELECT id, created_by FROM documents WHERE id = ? AND deleted_at IS NULL').get(id)
    : db.prepare('SELECT id, created_by FROM folders WHERE id = ?').get(id);
  if (!target) throw new HttpError(404, 'Nicht gefunden.');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const all = listShares({ kind, target: id });
  res.json({
    canShare: mayShare(user, kind, target),
    shares: req.user.role === 'admin' ? all : all.filter(s => s.userId === req.user.id),
    status: shareStatus(kind, id),
  });
});

shareRoutes.post('/', async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const { token, share } = await createShare(user, req.body || {});
  audit(req, 'share.created', `${share.kind}:${share.target}`, { title: share.title, expiresAt: share.expiresAt, password: share.hasPassword, includeChildren: share.includeChildren });
  res.status(201).json({ token, share });
});

shareRoutes.delete('/:id', (req, res) => {
  const sh = revokeShare(req.params.id, req.user);
  audit(req, 'share.revoked', `${sh.kind}:${sh.target_id}`, { id: sh.id });
  res.json({ ok: true });
});

// ---------- Öffentlich (ohne Konto) ----------
export const publicRoutes = Router();
const limiter = new RateLimiter(120, 15 * 60000);

publicRoutes.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (!limiter.hit(clientIp(req))) {
    res.setHeader('Retry-After', String(limiter.retryAfter(clientIp(req))));
    return next(new HttpError(429, 'Zu viele Anfragen. Bitte später erneut versuchen.'));
  }
  next();
});

// Token kommt im Body (nicht in der URL), damit es in keinem Log landet.
publicRoutes.post('/share', async (req, res) => {
  const data = await resolvePublic(req.body?.token, req.body?.password, clientIp(req));
  res.json({ ...data, appName: config.appName });
});

export { getShareSettings };
