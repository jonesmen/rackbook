// OpenID Connect (z. B. Authentik, Keycloak, Authelia) – Konfiguration über die Verwaltung.
import * as oidc from 'openid-client';
import { db, getSetting, setSetting, tx } from './db.js';
import { config } from './config.js';
import { HttpError, encrypt, decrypt, sha256, randomToken } from './security.js';

export const CALLBACK_PATH = '/api/auth/oidc/callback';

export const OIDC_DEFAULTS = {
  enabled: false,
  issuer: '',
  clientId: '',
  clientSecret: '', // verschlüsselt gespeichert
  scopes: 'openid profile email',
  buttonLabel: 'Mit Authentik anmelden',
  autoCreate: true,
  linkExisting: false,
  usernameClaim: 'preferred_username',
  groupsClaim: 'groups',
  allowedGroups: [],
  adminGroups: [],
  editorGroups: [],
  defaultRole: 'viewer',
  syncRoles: true,
  disablePasswordLogin: false,
  autoRedirect: false,
  logoutAtProvider: false,
  allowInsecure: false,
};

const list = v => (Array.isArray(v) ? v : String(v || '').split(','))
  .map(x => String(x).trim()).filter(Boolean).slice(0, 50).map(x => x.slice(0, 200));

export function getOidcSettings() {
  return { ...OIDC_DEFAULTS, ...getSetting('oidc', {}) };
}

// Ansicht für die Verwaltung: Secret wird nie herausgegeben.
export function adminView(req) {
  const s = getOidcSettings();
  return { ...s, clientSecret: '', hasClientSecret: !!s.clientSecret, redirectUri: redirectUri(req) };
}

export function saveOidcSettings(body) {
  const cur = getOidcSettings();
  const next = { ...cur };
  const b = body || {};
  const bools = ['enabled', 'autoCreate', 'linkExisting', 'syncRoles', 'disablePasswordLogin', 'autoRedirect', 'logoutAtProvider', 'allowInsecure'];
  for (const k of bools) if (b[k] !== undefined) next[k] = !!b[k];
  if (b.issuer !== undefined) {
    next.issuer = String(b.issuer).trim();
    if (next.issuer) {
      let u;
      try { u = new URL(next.issuer); } catch { throw new HttpError(400, 'Die Issuer-URL ist ungültig.'); }
      if (!['https:', 'http:'].includes(u.protocol)) throw new HttpError(400, 'Die Issuer-URL muss mit https:// beginnen.');
    }
  }
  if (b.clientId !== undefined) next.clientId = String(b.clientId).trim().slice(0, 300);
  if (b.clientSecret) next.clientSecret = encrypt(String(b.clientSecret).trim().slice(0, 1000));
  if (b.clearClientSecret) next.clientSecret = '';
  if (b.scopes !== undefined) {
    const sc = String(b.scopes).split(/[\s,]+/).filter(x => /^[\w.:/-]{1,100}$/.test(x));
    if (!sc.includes('openid')) sc.unshift('openid');
    next.scopes = sc.join(' ');
  }
  if (b.buttonLabel !== undefined) next.buttonLabel = String(b.buttonLabel).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || OIDC_DEFAULTS.buttonLabel;
  for (const k of ['usernameClaim', 'groupsClaim']) {
    if (b[k] !== undefined) {
      const v = String(b[k]).trim();
      if (!/^[\w.:/-]{1,100}$/.test(v)) throw new HttpError(400, `Ungültiger Claim-Name für ${k}.`);
      next[k] = v;
    }
  }
  for (const k of ['allowedGroups', 'adminGroups', 'editorGroups']) if (b[k] !== undefined) next[k] = list(b[k]);
  if (b.defaultRole !== undefined) {
    if (!['viewer', 'editor'].includes(b.defaultRole)) throw new HttpError(400, 'Standardrolle muss viewer oder editor sein.');
    next.defaultRole = b.defaultRole;
  }
  if (next.enabled && (!next.issuer || !next.clientId)) throw new HttpError(400, 'Zum Aktivieren werden Issuer-URL und Client-ID benötigt.');
  if (next.enabled && next.issuer.startsWith('http:') && !next.allowInsecure) {
    throw new HttpError(400, 'Die Issuer-URL nutzt HTTP. Bitte HTTPS verwenden oder „Unverschlüsseltes HTTP erlauben“ aktivieren.');
  }
  setSetting('oidc', next);
  cached = null;
  return next;
}

export function publicOidcState() {
  const s = getOidcSettings();
  if (!s.enabled) return { enabled: false };
  return { enabled: true, buttonLabel: s.buttonLabel, passwordLoginDisabled: s.disablePasswordLogin, autoRedirect: s.autoRedirect };
}

export function redirectUri(req) {
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  return base + CALLBACK_PATH;
}

// ---------- Discovery (mit Cache) ----------
let cached = null;
export async function getClient(s = getOidcSettings(), { fresh = false } = {}) {
  if (!s.issuer || !s.clientId) throw new HttpError(400, 'SSO ist nicht vollständig konfiguriert.');
  const secret = s.clientSecret ? decrypt(s.clientSecret) : '';
  const key = sha256([s.issuer, s.clientId, secret, s.allowInsecure].join('\u0000'));
  if (!fresh && cached && cached.key === key && Date.now() - cached.at < 3600000) return cached.client;
  const opts = { timeout: 10 };
  if (s.allowInsecure) opts.execute = [oidc.allowInsecureRequests];
  const auth = secret ? oidc.ClientSecretPost(secret) : oidc.None();
  let client;
  try {
    client = await oidc.discovery(new URL(s.issuer), s.clientId, secret ? { client_secret: secret } : {}, auth, opts);
  } catch (e) {
    throw new HttpError(502, `Der Identity Provider ist nicht erreichbar oder die Issuer-URL ist falsch (${e.code || e.message}).`);
  }
  cached = { key, client, at: Date.now() };
  return client;
}

// ---------- Login-Start ----------
export async function startLogin(req) {
  const s = getOidcSettings();
  if (!s.enabled) throw new HttpError(404, 'SSO ist nicht aktiviert.');
  const client = await getClient(s);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(client, {
    redirect_uri: redirectUri(req),
    scope: s.scopes,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  // Flow-Daten verschlüsselt im Cookie: keine Server-Session vor der Anmeldung nötig.
  const blob = encrypt(JSON.stringify({ v: verifier, s: state, n: nonce, exp: Date.now() + 10 * 60000, r: redirectUri(req) }));
  return { url: url.href, blob };
}

export function readFlow(blob) {
  try {
    const f = JSON.parse(decrypt(blob));
    return f.exp > Date.now() ? f : null;
  } catch { return null; }
}

function claimValue(obj, path) {
  if (obj[path] !== undefined) return obj[path];
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

// ---------- Callback ----------
export async function finishLogin(req, flow) {
  const s = getOidcSettings();
  if (!s.enabled) throw new HttpError(404, 'SSO ist nicht aktiviert.');
  const client = await getClient(s);
  const currentUrl = new URL(req.originalUrl, flow.r);
  let tokens;
  try {
    tokens = await oidc.authorizationCodeGrant(client, currentUrl, {
      pkceCodeVerifier: flow.v, expectedState: flow.s, expectedNonce: flow.n, idTokenExpected: true,
    }, { redirect_uri: flow.r });
  } catch (e) {
    throw new HttpError(401, `Anmeldung beim Identity Provider fehlgeschlagen (${e.error || e.code || e.message}).`);
  }
  const idClaims = tokens.claims();
  let claims = { ...idClaims };
  try {
    const info = await oidc.fetchUserInfo(client, tokens.access_token, idClaims.sub);
    claims = { ...info, ...idClaims, ...(info[s.groupsClaim] !== undefined ? { [s.groupsClaim]: info[s.groupsClaim] } : {}) };
  } catch { /* UserInfo ist optional */ }
  return { claims, issuer: client.serverMetadata().issuer, idToken: tokens.id_token };
}

function roleFor(s, groups) {
  const has = arr => arr.some(g => groups.includes(g));
  if (s.adminGroups.length && has(s.adminGroups)) return 'admin';
  if (s.editorGroups.length && has(s.editorGroups)) return 'editor';
  return s.defaultRole;
}

const activeAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get().n;

// Ordnet die Identität einem lokalen Benutzer zu (oder legt ihn an). Gibt { user, created } zurück.
export function resolveUser({ claims, issuer }) {
  const s = getOidcSettings();
  const sub = String(claims.sub || '');
  if (!sub) throw new HttpError(401, 'Der Identity Provider hat keine Benutzer-ID (sub) geliefert.');
  const rawGroups = claimValue(claims, s.groupsClaim);
  const groups = (Array.isArray(rawGroups) ? rawGroups : rawGroups ? [rawGroups] : []).map(String);
  if (s.allowedGroups.length && !s.allowedGroups.some(g => groups.includes(g))) {
    throw new HttpError(403, 'Dein Konto ist für Rackbook nicht freigegeben (keine erlaubte Gruppe).');
  }
  const role = roleFor(s, groups);
  const email = typeof claims.email === 'string' ? claims.email.slice(0, 200) : null;
  const displayName = String(claims.name || claims.preferred_username || claims.email || 'SSO-Benutzer').replace(/[\u0000-\u001f<>]/g, '').slice(0, 60);
  const now = Date.now();

  return tx(() => {
    const ident = db.prepare('SELECT user_id FROM user_identities WHERE issuer = ? AND subject = ?').get(issuer, sub);
    let user = ident && db.prepare('SELECT * FROM users WHERE id = ?').get(ident.user_id);
    let created = false;

    if (!user) {
      const wanted = String(claimValue(claims, s.usernameClaim) || claims.preferred_username || claims.email || '').split('@')[0];
      const base = wanted.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 28) || 'sso';
      const existing = wanted && db.prepare('SELECT * FROM users WHERE username = ?').get(base);
      if (existing && s.linkExisting) {
        user = existing;
      } else {
        if (!s.autoCreate) throw new HttpError(403, 'Für dieses SSO-Konto gibt es keinen Rackbook-Benutzer. Bitte einen Administrator kontaktieren.');
        let username = base.length >= 3 ? base : (base + '-sso');
        let i = 2;
        while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) username = `${base.slice(0, 26)}-${i++}`;
        const info = db.prepare(`INSERT INTO users (username, display_name, password_hash, role, status, created_at, updated_at, password_changed_at)
                                 VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`)
          .run(username, displayName, '!sso:' + randomToken(8), role, now, now, now);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
        created = true;
      }
      db.prepare('INSERT INTO user_identities (issuer, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(issuer, sub, user.id, email, now);
    }

    if (user.status !== 'active') throw new HttpError(403, user.status === 'pending' ? 'Dein Konto wartet noch auf Freischaltung.' : 'Dieses Konto ist deaktiviert.');

    // Rollen aus Gruppen übernehmen – aber den letzten Administrator nie herabstufen.
    let newRole = user.role;
    if (!created && s.syncRoles && (s.adminGroups.length || s.editorGroups.length)) {
      newRole = role;
      if (user.role === 'admin' && newRole !== 'admin' && activeAdmins() <= 1) newRole = 'admin';
    }
    db.prepare('UPDATE users SET role = ?, display_name = ?, updated_at = ? WHERE id = ?')
      .run(newRole, created ? user.display_name : displayName || user.display_name, now, user.id);
    db.prepare('UPDATE user_identities SET last_login_at = ?, email = ? WHERE issuer = ? AND subject = ?').run(now, email, issuer, sub);
    return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(user.id), created, roleChanged: newRole !== user.role };
  });
}

export async function endSessionUrl(req) {
  const s = getOidcSettings();
  if (!s.enabled || !s.logoutAtProvider) return null;
  try {
    const client = await getClient(s);
    if (!client.serverMetadata().end_session_endpoint) return null;
    const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
    return oidc.buildEndSessionUrl(client, { post_logout_redirect_uri: base + '/' }).href;
  } catch { return null; }
}

export async function testConnection() {
  const client = await getClient(getOidcSettings(), { fresh: true });
  const m = client.serverMetadata();
  return {
    issuer: m.issuer,
    authorizationEndpoint: m.authorization_endpoint,
    tokenEndpoint: m.token_endpoint,
    userinfoEndpoint: m.userinfo_endpoint || null,
    endSessionEndpoint: m.end_session_endpoint || null,
    pkce: (m.code_challenge_methods_supported || []).includes('S256'),
  };
}
