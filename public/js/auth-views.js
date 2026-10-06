import { html, useState, useEffect } from '/vendor/preact-htm.js';
import { api, setCsrf } from './api.js';
import { Icon } from './util.js';

const Brand = () => html`<div class="brand"><div class="logo">R</div><span class="brand-name">Rackbook</span></div>`;
const ErrorBox = ({ msg }) => msg ? html`<div class="notice err" role="alert"><${Icon} name="error" />${msg}</div>` : null;

const SSO_URL = '/api/auth/oidc/login';

// Fehlermeldung aus dem SSO-Rücksprung einmalig aus der URL lesen und entfernen.
function takeSsoError() {
  const qs = new URLSearchParams(location.search);
  const e = qs.get('sso_error');
  if (e !== null) { qs.delete('sso_error'); history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : '')); }
  return e;
}

export function AuthScreen({ state, onAuthed }) {
  const [mode, setMode] = useState(state.setupRequired ? 'setup' : 'login');
  const sso = state.sso || { enabled: false };
  const [ssoErr] = useState(() => takeSsoError());
  const forceLocal = new URLSearchParams(location.search).has('local');
  const [showLocal, setShowLocal] = useState(!sso.enabled || !sso.passwordLoginDisabled || forceLocal);
  useEffect(() => {
    if (mode === 'login' && sso.enabled && sso.autoRedirect && !ssoErr && !forceLocal) location.assign(SSO_URL);
  }, []);
  const [f, setF] = useState({ username: '', displayName: '', password: '', password2: '', code: '' });
  const [ticket, setTicket] = useState(null);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const min = state.passwordMinLength;

  const run = async fn => {
    setErr(''); setBusy(true);
    try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const finish = r => { setCsrf(r.csrfToken); onAuthed(r.user, r.csrfToken); };

  const submit = e => {
    e.preventDefault();
    if (mode === 'login') return run(async () => {
      const r = await api('/auth/login', { method: 'POST', body: { username: f.username.trim(), password: f.password } });
      if (r.mfaRequired) { setTicket(r.ticket); setMode('mfa'); setF({ ...f, password: '', code: '' }); return; }
      finish(r);
    });
    if (mode === 'mfa') return run(async () => finish(await api('/auth/login/mfa', { method: 'POST', body: { ticket, code: f.code } })));
    // setup / register
    return run(async () => {
      if (f.password !== f.password2) throw new Error('Die Passwörter stimmen nicht überein.');
      const r = await api('/auth/register', { method: 'POST', body: { username: f.username.trim(), displayName: f.displayName.trim(), password: f.password } });
      if (r.pending) { setInfo(r.message); setMode('login'); setF({ ...f, password: '', password2: '' }); return; }
      finish(r);
    });
  };

  const title = { setup: 'Ersteinrichtung', login: 'Anmelden', register: 'Konto erstellen', mfa: 'Zwei-Faktor-Bestätigung' }[mode];
  return html`
    <div class="auth-wrap">
      <form class="auth-card" onSubmit=${submit} autocomplete="on">
        <${Brand} />
        <div>
          <h1>${title}</h1>
          ${mode === 'setup' && html`<p style=${{ marginTop: '6px' }}>Willkommen! Lege das erste Konto an – es erhält automatisch Administratorrechte.</p>`}
          ${mode === 'mfa' && html`<p style=${{ marginTop: '6px' }}>Gib den 6-stelligen Code aus deiner Authenticator-App ein.</p>`}
        </div>
        ${info && html`<div class="notice"><${Icon} name="info" />${info}</div>`}
        <${ErrorBox} msg=${err || ssoErr} />
        ${mode === 'login' && sso.enabled && html`
          <a class="btn btn-primary sso-btn" href=${SSO_URL}><${Icon} name="key" />${sso.buttonLabel}</a>
          ${showLocal ? html`<div class="divider"><span>oder mit Benutzername</span></div>`
            : html`<div class="auth-foot"><button type="button" onClick=${() => setShowLocal(true)}>Notfallzugang für Administratoren</button></div>`}`}
        ${mode === 'login' && !showLocal ? null : mode === 'mfa' ? html`
          <label class="field"><span>Code</span>
            <input class="input mono" value=${f.code} onInput=${set('code')} inputmode="numeric" autocomplete="one-time-code" maxlength="7" pattern="[0-9 ]*" required autofocus />
          </label>` : html`
          <label class="field"><span>Benutzername</span>
            <input class="input" value=${f.username} onInput=${set('username')} autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="32" autofocus />
          </label>
          ${(mode === 'setup' || mode === 'register') && html`
            <label class="field"><span>Anzeigename</span>
              <input class="input" value=${f.displayName} onInput=${set('displayName')} autocomplete="name" maxlength="60" placeholder="z. B. Alex Muster" />
            </label>`}
          <label class="field"><span>Passwort</span>
            <input class="input" type="password" value=${f.password} onInput=${set('password')} autocomplete=${mode === 'login' ? 'current-password' : 'new-password'} required minlength=${mode === 'login' ? 1 : min} maxlength="256" />
          </label>
          ${(mode === 'setup' || mode === 'register') && html`
            <label class="field"><span>Passwort wiederholen</span>
              <input class="input" type="password" value=${f.password2} onInput=${set('password2')} autocomplete="new-password" required minlength=${min} maxlength="256" />
            </label>
            <div class="hint">Mindestens ${min} Zeichen. Nicht den Benutzernamen verwenden.</div>`}
        `}
        ${(mode !== 'login' || showLocal) && html`<button class=${'btn ' + (mode === 'login' && sso.enabled ? 'btn-ghost' : 'btn-primary')} type="submit" disabled=${busy}>
          ${busy ? 'Bitte warten …' : mode === 'login' ? 'Anmelden' : mode === 'mfa' ? 'Bestätigen' : mode === 'setup' ? 'Administrator anlegen' : 'Registrieren'}
        </button>`}
        ${mode === 'login' && state.registrationEnabled && html`<div class="auth-foot">Noch kein Konto? <button type="button" onClick=${() => { setErr(''); setInfo(''); setMode('register'); }}>Registrieren</button></div>`}
        ${mode === 'register' && html`<div class="auth-foot">Bereits registriert? <button type="button" onClick=${() => { setErr(''); setMode('login'); }}>Anmelden</button></div>`}
        ${mode === 'mfa' && html`<div class="auth-foot"><button type="button" onClick=${() => { setErr(''); setTicket(null); setMode('login'); }}>Zurück zur Anmeldung</button></div>`}
      </form>
    </div>`;
}

export function ForcePasswordChange({ user, minLength, onDone, onLogout }) {
  const [f, setF] = useState({ cur: '', pw: '', pw2: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const submit = async e => {
    e.preventDefault(); setErr('');
    if (f.pw !== f.pw2) return setErr('Die Passwörter stimmen nicht überein.');
    setBusy(true);
    try {
      const r = await api('/me/password', { method: 'POST', body: { currentPassword: f.cur, newPassword: f.pw } });
      onDone(r.user);
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return html`
    <div class="auth-wrap">
      <form class="auth-card" onSubmit=${submit}>
        <${Brand} />
        <div><h1>Neues Passwort festlegen</h1><p style=${{ marginTop: '6px' }}>Hallo ${user.displayName}, ein Administrator hat dein Passwort zurückgesetzt. Bitte vergib jetzt ein eigenes.</p></div>
        <${ErrorBox} msg=${err} />
        <input type="text" autocomplete="username" value=${user.username} hidden readonly />
        <label class="field"><span>Aktuelles (vorläufiges) Passwort</span><input class="input" type="password" value=${f.cur} onInput=${set('cur')} autocomplete="current-password" required /></label>
        <label class="field"><span>Neues Passwort</span><input class="input" type="password" value=${f.pw} onInput=${set('pw')} autocomplete="new-password" minlength=${minLength} required /></label>
        <label class="field"><span>Neues Passwort wiederholen</span><input class="input" type="password" value=${f.pw2} onInput=${set('pw2')} autocomplete="new-password" minlength=${minLength} required /></label>
        <button class="btn btn-primary" disabled=${busy}>${busy ? 'Bitte warten …' : 'Passwort speichern'}</button>
        <div class="auth-foot"><button type="button" onClick=${onLogout}>Abmelden</button></div>
      </form>
    </div>`;
}
