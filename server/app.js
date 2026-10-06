import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, migrate, getSetting } from './db.js';
import { config } from './config.js';
import { HttpError, securityHeaders } from './security.js';
import { sessionMiddleware, csrfProtection, requireAuth, requireRole } from './auth.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import docRoutes, { insertDoc } from './routes/docs.js';
import adminRoutes from './routes/admin.js';
import { DEFAULT_FOLDERS, sampleDocs } from './seed.js';
import { mcpHandler, getMcpSettings, grantableScopes, mcpEndpoint } from './mcp.js';
import { shareRoutes, publicRoutes, getShareSettings } from './routes/shares.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function initDatabase() {
  migrate();
  if (db.prepare('SELECT COUNT(*) AS n FROM folders').get().n === 0) {
    DEFAULT_FOLDERS.forEach((f, i) => db.prepare('INSERT INTO folders (id, name, icon, hue, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.id, f.name, f.icon, f.hue, i, Date.now()));
    if (config.seedSampleDocs) sampleDocs().forEach(d => insertDoc({ ...d, id: 'sample-' + d.id, created: d.updated }, null));
  }
}

// Regelmäßige Aufräumarbeiten: abgelaufene Sitzungen, Papierkorb, alte Audit-Einträge.
export function housekeeping() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?').run(now, now - config.sessionIdleMinutes * 60000);
  db.prepare('DELETE FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(now - config.trashRetentionDays * 86400000);
  db.prepare('DELETE FROM audit_log WHERE ts < ?').run(now - config.auditRetentionDays * 86400000);
  // Abgelaufene/widerrufene Freigaben nach 30 Tagen endgültig entfernen
  db.prepare('DELETE FROM shares WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR (expires_at IS NOT NULL AND expires_at < ?)').run(now - 30 * 86400000, now - 30 * 86400000);
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', 'strong');

  app.use(securityHeaders);
  app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); });

  // MCP-Server für KI-Assistenten (Bearer-Token, keine Cookies → eigener Pfad ohne CSRF/Session)
  app.all('/mcp', express.json({ limit: Math.max(2, Math.ceil((config.maxDocBytes * 3) / 1048576)) + 'mb' }), (req, res, next) => {
    Promise.resolve(mcpHandler(req, res)).catch(next);
  });

  const api = express.Router();
  api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use(express.json({ limit: Math.max(2, Math.ceil((config.maxDocBytes * 25) / 1048576)) + 'mb' }));
  api.use(sessionMiddleware);
  api.use(csrfProtection);
  api.use('/auth', authRoutes);
  api.use('/public', publicRoutes);
  api.use(requireAuth);
  api.use('/me', meRoutes);
  api.get('/meta', (req, res) => res.json({
    staleDays: getSetting('stale_days', config.staleDaysDefault),
    trashRetentionDays: config.trashRetentionDays,
    maxDocBytes: config.maxDocBytes,
    sharing: (() => {
      const sh = getShareSettings();
      return { enabled: sh.enabled, maxDays: sh.maxDays, defaultDays: sh.defaultDays, requirePassword: sh.requirePassword, allowEditors: sh.allowEditors };
    })(),
    mcp: (() => {
      const m = getMcpSettings();
      return { enabled: m.enabled, endpoint: mcpEndpoint(req), grantable: m.enabled ? grantableScopes(req.user.role, m) : [], maxTokenDays: m.maxTokenDays };
    })(),
  }));
  api.use('/shares', shareRoutes);
  api.use('/admin', requireRole('admin'), adminRoutes);
  api.use('/', docRoutes);
  api.use(() => { throw new HttpError(404, 'Nicht gefunden.'); });
  app.use('/api', api);

  app.use(express.static(publicDir, {
    index: false,
    setHeaders(res, path) {
      res.setHeader('Cache-Control', /\/(fonts|vendor)\//.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));
  // Öffentliche Freigabeseite (Token im URL-Fragment, nie in der Server-URL)
  app.get('/share', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.sendFile(join(publicDir, 'share.html'));
  });
  // SPA-Fallback: alle übrigen GET-Anfragen liefern die App-Shell aus.
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(publicDir, 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') err = new HttpError(413, 'Anfrage zu groß.');
    else if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Ungültiges JSON.');
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Interner Serverfehler.' : err.message, ...(err.extra || {}) });
  });
  return app;
}
