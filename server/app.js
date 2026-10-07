import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, migrate, getSetting } from './db.js';
import { config } from './config.js';
import { HttpError, securityHeaders, setCspExtra } from './security.js';
import { sessionMiddleware, csrfProtection, requireAuth, requireRole } from './auth.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import docRoutes, { insertDoc } from './routes/docs.js';
import adminRoutes from './routes/admin.js';
import { DEFAULT_FOLDERS, sampleDocs } from './seed.js';
import { mcpHandler, getMcpSettings, grantableScopes, mcpEndpoint, hasValidToken } from './mcp.js';
import { shareRoutes, publicRoutes, getShareSettings } from './routes/shares.js';
import { fileApi, serveFile, getEditorSettings, cleanupFiles, editorCspExtra } from './files.js';
import { syncedApi, cleanupSynced } from './synced.js';
import { templateApi } from './templates.js';
import { assetApi } from './assets.js';

setCspExtra(editorCspExtra);

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
  // Nicht mehr verwendete Dateien und synchronisierte Blöcke
  cleanupFiles();
  cleanupSynced();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', 'strong');

  app.use(securityHeaders);
  app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); });

  // MCP-Server für KI-Assistenten (Bearer-Token, keine Cookies → eigener Pfad ohne CSRF/Session)
  // Gültiges Token → größere Anfragen erlaubt (Datei-Uploads, Base64); sonst nur kleine Anfragen parsen.
  const mcpSmall = express.json({ limit: Math.max(2, Math.ceil((config.maxDocBytes * 3) / 1048576)) + 'mb' });
  const mcpLarge = express.json({ limit: '30mb' });
  app.all('/mcp', (req, res, next) => (hasValidToken(req) ? mcpLarge : mcpSmall)(req, res, next), (req, res, next) => {
    Promise.resolve(mcpHandler(req, res)).catch(next);
  });

  const api = express.Router();
  api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use(sessionMiddleware);
  // Vollständige Backups (inkl. Dateien) können groß sein – das höhere Limit gilt nur für angemeldete Admins.
  const jsonStd = express.json({ limit: Math.max(2, Math.ceil((config.maxDocBytes * 25) / 1048576)) + 'mb' });
  const jsonBig = express.json({ limit: '2gb' });
  api.use((req, res, next) => (req.path === '/admin/restore' && req.user?.role === 'admin' ? jsonBig : jsonStd)(req, res, next));
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
    editor: (() => {
      const e = getEditorSettings();
      return { uploads: e.uploads, uploadMaxMb: e.uploadMaxMb, embeds: e.embeds, drawioUrl: e.drawioUrl };
    })(),
    mcp: (() => {
      const m = getMcpSettings();
      return { enabled: m.enabled, endpoint: mcpEndpoint(req), grantable: m.enabled ? grantableScopes(req.user.role, m) : [], maxTokenDays: m.maxTokenDays };
    })(),
  }));
  api.use('/shares', shareRoutes);
  api.use('/files', fileApi);
  api.use('/synced', syncedApi);
  api.use('/templates', templateApi);
  api.use('/assets', assetApi);
  api.use('/admin', requireRole('admin'), adminRoutes);
  api.use('/', docRoutes);
  api.use(() => { throw new HttpError(404, 'Nicht gefunden.'); });
  app.use('/api', api);

  // Hochgeladene Dateien (Sitzung oder signierter Link aus einer Freigabe)
  app.get('/files/:id', sessionMiddleware, serveFile);

  app.use(express.static(publicDir, {
    index: false,
    setHeaders(res, path) {
      res.setHeader('Cache-Control', /\/(fonts|vendor)\/(?!excalidraw\/app|katex|mermaid)/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      // Der Excalidraw-Editor läuft eingebettet (iframe) und braucht WebAssembly/Worker für den SVG-Export.
      if (/[\\/]mermaid-frame\.html$/.test(path)) {
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      }
      if (/[\\/]excalidraw\.html$/.test(path)) {
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      }
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
