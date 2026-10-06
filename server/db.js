import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbFile);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
`);

// Migrationen werden anhand von PRAGMA user_version nacheinander angewendet.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','disabled')),
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER,
    password_changed_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'folder',
    hue INTEGER NOT NULL DEFAULT 250,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    folder_id TEXT NOT NULL REFERENCES folders(id),
    content TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at INTEGER,
    deleted_at INTEGER,
    deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX documents_folder ON documents(folder_id);
  CREATE INDEX documents_deleted ON documents(deleted_at);
  CREATE TABLE revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    tags TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX revisions_doc ON revisions(doc_id, version);
  CREATE TABLE bookmarks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, doc_id)
  );
  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    target TEXT,
    ip TEXT,
    details TEXT
  );
  CREATE INDEX audit_ts ON audit_log(ts);
  `,
  // 2: Verknüpfung von Benutzern mit externen Identitäten (OIDC / SSO)
  `
  CREATE TABLE user_identities (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER,
    PRIMARY KEY (issuer, subject)
  );
  CREATE INDEX user_identities_user ON user_identities(user_id);
  `,
  // 3: Zugriffstokens für den MCP-Server (KI-Assistenten) und Herkunft von Änderungen
  `
  CREATE TABLE mcp_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '["read"]',
    folders TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_used_at INTEGER,
    last_used_ip TEXT,
    revoked_at INTEGER
  );
  CREATE INDEX mcp_tokens_user ON mcp_tokens(user_id);
  ALTER TABLE documents ADD COLUMN updated_via TEXT;
  ALTER TABLE revisions ADD COLUMN via TEXT;
  `,
  // 4: Unterordner und Unterseiten
  `
  ALTER TABLE folders ADD COLUMN parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
  ALTER TABLE documents ADD COLUMN parent_id TEXT REFERENCES documents(id) ON DELETE SET NULL;
  CREATE INDEX folders_parent ON folders(parent_id);
  CREATE INDEX documents_parent ON documents(parent_id);
  `,
  // 5: Öffentliche Freigaben per Link
  `
  ALTER TABLE folders ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  CREATE TABLE shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('doc','folder')),
    target_id TEXT NOT NULL,
    include_children INTEGER NOT NULL DEFAULT 1,
    password_hash TEXT,
    label TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    view_count INTEGER NOT NULL DEFAULT 0,
    last_viewed_at INTEGER
  );
  CREATE INDEX shares_user ON shares(user_id);
  CREATE INDEX shares_target ON shares(kind, target_id);
  `,
  // 6: Dateien (Bilder, Videos, PDFs, Anhänge) und synchronisierte Blöcke
  `
  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    doc_id TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX files_doc ON files(doc_id);
  CREATE TABLE synced_blocks (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL
  );
  `,
];

export function migrate() {
  const { user_version: v } = db.prepare('PRAGMA user_version').get();
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
