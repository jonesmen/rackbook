import { html, useState, useEffect } from '/vendor/preact-htm.js';
import { api } from './api.js';
import { Icon, Toggle, fcol, fmtDate, fmtDateTime, describeUA, ROLE_LABEL } from './util.js';

const PanelHead = ({ title, desc }) => html`<div><h2 class="h2 s16">${title}</h2>${desc && html`<p class="desc">${desc}</p>`}</div>`;
const SetToggle = ({ title, desc, on, onClick }) => html`
  <button type="button" class="set-row" onClick=${onClick} role="switch" aria-checked=${on}>
    <div><div class="t">${title}</div><div class="s">${desc}</div></div><${Toggle} on=${on} />
  </button>`;

// ---------------- Profil ----------------
function ProfilePanel({ app }) {
  const u = app.state.user;
  const [name, setName] = useState(u.displayName);
  useEffect(() => setName(u.displayName), [u.displayName]);
  const save = () => { if (name.trim() && name.trim() !== u.displayName) app.updateMe({ displayName: name.trim() }, 'Anzeigename gespeichert'); };
  return html`
    <div class="panel">
      <h2 class="h2 s16">Profil</h2>
      <div class="form-grid">
        <label class="field"><span>Anzeigename</span>
          <input class="input" value=${name} maxlength="60" onInput=${e => setName(e.target.value)} onBlur=${save} onKeyDown=${e => e.key === 'Enter' && e.target.blur()} />
        </label>
        <label class="field"><span>Benutzername</span><input class="input" value=${u.username} disabled /></label>
      </div>
      <div class="small muted">Rolle: <span class=${'pill ' + u.role}>${ROLE_LABEL[u.role]}</span> · Mitglied seit ${fmtDate(u.createdAt)}</div>
    </div>`;
}

// ---------------- Darstellung & Editor ----------------
function AppearancePanel({ app }) {
  const st = app.settings();
  return html`
    <div class="panel tight">
      <h2 class="h2 s16" style=${{ marginBottom: '8px' }}>Darstellung</h2>
      <div class="set-row static">
        <div><div class="t">Akzentfarbe</div><div class="s">Farbe für Hervorhebungen und Markierungen</div></div>
        <div style=${{ display: 'flex', gap: '8px' }}>
          ${['mint', 'blau', 'violett'].map(a => html`<button type="button" title=${a} aria-label=${'Akzent ' + a} class=${`accent-dot ${a}${st.accent === a ? ' on' : ''}`} onClick=${() => app.setSettings({ accent: a })}></button>`)}
        </div>
      </div>
      <div class="set-row static">
        <div><div class="t">Startseite</div><div class="s">Seite nach der Anmeldung</div></div>
        <div class="seg">
          ${[['dashboard', 'Dashboard'], ['docs', 'Dokumente']].map(([v, l]) => html`<button type="button" class=${st.startPage === v ? 'on' : ''} onClick=${() => app.setSettings({ startPage: v })}>${l}</button>`)}
        </div>
      </div>
      <${SetToggle} title="Seitenleiste eingeklappt" desc="Nur Symbole in der Navigation anzeigen" on=${st.sidebarCollapsed} onClick=${() => app.setSettings({ sidebarCollapsed: !st.sidebarCollapsed })} />
    </div>
    <div class="panel tight">
      <h2 class="h2 s16" style=${{ marginBottom: '8px' }}>Editor</h2>
      <${SetToggle} title="Live-Vorschau" desc="Gerendertes Markdown neben dem Editor anzeigen" on=${st.livePreview} onClick=${() => app.setSettings({ livePreview: !st.livePreview })} />
      <${SetToggle} title="Zeilenumbruch" desc="Lange Zeilen im Editor umbrechen" on=${st.wrap} onClick=${() => app.setSettings({ wrap: !st.wrap })} />
      <div class="set-row static">
        <div><div class="t">Schriftgröße</div><div class="s">Monospace-Schrift im Editor</div></div>
        <div class="seg">${[13, 14, 16].map(n => html`<button type="button" class=${st.fontSize === n ? 'on' : ''} onClick=${() => app.setSettings({ fontSize: n })}>${n} px</button>`)}</div>
      </div>
    </div>`;
}

// ---------------- Sicherheit ----------------
function PasswordForm({ app }) {
  const [f, setF] = useState({ cur: '', pw: '', pw2: '' });
  const [err, setErr] = useState('');
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const submit = async e => {
    e.preventDefault(); setErr('');
    if (f.pw !== f.pw2) return setErr('Die Passwörter stimmen nicht überein.');
    try {
      const r = await api('/me/password', { method: 'POST', body: { currentPassword: f.cur, newPassword: f.pw } });
      app.setState({ user: r.user }); setF({ cur: '', pw: '', pw2: '' });
      app.flash('Passwort geändert – andere Sitzungen wurden abgemeldet');
    } catch (x) { setErr(x.message); }
  };
  return html`
    <form onSubmit=${submit} style=${{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div class="t" style=${{ fontSize: '13px', fontWeight: 600 }}>Passwort ändern</div>
      <input type="text" autocomplete="username" value=${app.state.user.username} hidden readonly />
      <div class="form-grid">
        <label class="field"><span>Aktuelles Passwort</span><input class="input" type="password" autocomplete="current-password" value=${f.cur} onInput=${set('cur')} required /></label>
        <label class="field"><span>Neues Passwort</span><input class="input" type="password" autocomplete="new-password" minlength=${app.state.passwordMinLength} value=${f.pw} onInput=${set('pw')} required /></label>
        <label class="field"><span>Wiederholen</span><input class="input" type="password" autocomplete="new-password" minlength=${app.state.passwordMinLength} value=${f.pw2} onInput=${set('pw2')} required /></label>
      </div>
      ${err && html`<div class="err">${err}</div>`}
      <div><button class="btn btn-ghost md"><${Icon} name="key" />Passwort ändern</button></div>
    </form>`;
}

function TotpPanel({ app }) {
  const u = app.state.user;
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const start = async () => { setErr(''); try { setSetup(await api('/me/totp/setup', { method: 'POST', body: {} })); } catch (x) { setErr(x.message); } };
  const enable = async e => {
    e.preventDefault(); setErr('');
    try { const r = await api('/me/totp/enable', { method: 'POST', body: { code } }); app.setState({ user: r.user }); setSetup(null); setCode(''); app.flash('Zwei-Faktor-Authentifizierung aktiviert'); }
    catch (x) { setErr(x.message); }
  };
  const disable = async e => {
    e.preventDefault(); setErr('');
    try { const r = await api('/me/totp/disable', { method: 'POST', body: { code, password: pw } }); app.setState({ user: r.user }); setCode(''); setPw(''); app.flash('Zwei-Faktor-Authentifizierung deaktiviert'); }
    catch (x) { setErr(x.message); }
  };
  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid var(--line2)', paddingTop: '14px' }}>
      <div class="row-between">
        <div><div style=${{ fontSize: '13px', fontWeight: 600 }}>Zwei-Faktor-Authentifizierung (TOTP)</div>
          <div class="small muted" style=${{ marginTop: '2px' }}>Zusätzlicher Code aus einer Authenticator-App (z. B. Aegis, 2FAS, Google Authenticator).</div></div>
        <span class=${'pill ' + (u.totpEnabled ? 'ok' : 'warn')}>${u.totpEnabled ? 'Aktiv' : 'Inaktiv'}</span>
      </div>
      ${!u.totpEnabled && !setup && html`<div><button type="button" class="btn btn-ghost md" onClick=${start}><${Icon} name="shield_lock" />2FA einrichten</button></div>`}
      ${!u.totpEnabled && setup && html`
        <form onSubmit=${enable} style=${{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-start' }}>
          <img class="qr" src=${setup.qr} alt="QR-Code für die Authenticator-App" />
          <div style=${{ display: 'flex', flexDirection: 'column', gap: '10px', flex: '1 1 240px' }}>
            <div class="small muted">1. QR-Code scannen oder den Schlüssel manuell eingeben:</div>
            <div class="secret">${setup.secret.match(/.{1,4}/g).join(' ')}</div>
            <label class="field"><span>2. Angezeigten Code eingeben</span><input class="input mono" inputmode="numeric" autocomplete="one-time-code" maxlength="7" value=${code} onInput=${e => setCode(e.target.value)} required /></label>
            <div class="btn-row"><button class="btn btn-primary md">Aktivieren</button><button type="button" class="btn btn-ghost md" onClick=${() => setSetup(null)}>Abbrechen</button></div>
          </div>
        </form>`}
      ${u.totpEnabled && html`
        <form onSubmit=${disable} class="form-grid">
          <input type="text" autocomplete="username" value=${u.username} hidden readonly />
          <label class="field"><span>Passwort</span><input class="input" type="password" autocomplete="current-password" value=${pw} onInput=${e => setPw(e.target.value)} required /></label>
          <label class="field"><span>Aktueller Code</span><input class="input mono" inputmode="numeric" maxlength="7" value=${code} onInput=${e => setCode(e.target.value)} required /></label>
          <div><button class="btn btn-danger md"><${Icon} name="remove_moderator" />2FA deaktivieren</button></div>
        </form>`}
      ${err && html`<div class="err">${err}</div>`}
    </div>`;
}

function SessionsPanel({ app }) {
  const [list, setList] = useState(null);
  const load = () => api('/me/sessions').then(r => setList(r.sessions)).catch(e => app.flash(e.message, null, true));
  useEffect(() => { load(); }, []);
  const revoke = async id => { await api('/me/sessions/' + id, { method: 'DELETE' }).catch(e => app.flash(e.message, null, true)); load(); };
  const revokeAll = async () => { await api('/me/sessions', { method: 'DELETE' }).catch(e => app.flash(e.message, null, true)); load(); app.flash('Alle anderen Sitzungen abgemeldet'); };
  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', gap: '8px', borderTop: '1px solid var(--line2)', paddingTop: '14px' }}>
      <div class="row-between">
        <div style=${{ fontSize: '13px', fontWeight: 600 }}>Aktive Sitzungen</div>
        ${list && list.length > 1 && html`<button type="button" class="link-acc" onClick=${revokeAll}>Alle anderen abmelden</button>`}
      </div>
      <div class="list-plain">
        ${(list || []).map(s => html`
          <div>
            <${Icon} name=${/Android|iPhone|iPad/.test(s.userAgent || '') ? 'smartphone' : 'computer'} cls="s18 muted" />
            <div style=${{ flex: 1, minWidth: 0 }}>
              <div style=${{ fontSize: '13px', fontWeight: 600 }}>${describeUA(s.userAgent)} ${s.current && html`<span class="pill ok">Diese Sitzung</span>`}</div>
              <div class="xs muted">${s.ip || 'unbekannte IP'} · zuletzt aktiv ${fmtDate(s.lastSeenAt)} · angemeldet ${fmtDateTime(s.createdAt)}</div>
            </div>
            ${!s.current && html`<button type="button" class="btn btn-ghost sm" onClick=${() => revoke(s.id)}>Abmelden</button>`}
          </div>`)}
      </div>
    </div>`;
}

function SecurityPanel({ app }) {
  return html`
    <div class="panel">
      <${PanelHead} title="Sicherheit" desc="Passwort, Zwei-Faktor-Authentifizierung und angemeldete Geräte." />
      <${PasswordForm} app=${app} />
      <${TotpPanel} app=${app} />
      <${SessionsPanel} app=${app} />
      <div style=${{ borderTop: '1px solid var(--line2)', paddingTop: '14px' }}>
        <button type="button" class="btn btn-ghost md" onClick=${() => app.logout()}><${Icon} name="logout" />Abmelden</button>
      </div>
    </div>`;
}

// ---------------- Ordner ----------------
function FolderRow({ app, f, count }) {
  const [v, setV] = useState({ name: f.name, icon: f.icon, hue: f.hue });
  useEffect(() => setV({ name: f.name, icon: f.icon, hue: f.hue }), [f.name, f.icon, f.hue]);
  const dirty = v.name !== f.name || v.icon !== f.icon || Number(v.hue) !== f.hue;
  const c = fcol(v.hue);
  return html`
    <div>
      <div class="ficon s32" style=${c}><${Icon} name=${/^[a-z0-9_]+$/.test(v.icon) ? v.icon : 'folder'} /></div>
      <input class="input" style=${{ flex: '1 1 160px' }} value=${v.name} maxlength="60" onInput=${e => setV({ ...v, name: e.target.value })} aria-label="Name" />
      <input class="input mono" style=${{ width: '140px' }} value=${v.icon} maxlength="40" onInput=${e => setV({ ...v, icon: e.target.value.trim() })} aria-label="Icon" title="Material-Symbol-Name, z. B. dns, lan, router" />
      <input type="range" min="0" max="360" value=${v.hue} onInput=${e => setV({ ...v, hue: Number(e.target.value) })} aria-label="Farbton" style=${{ width: '90px' }} />
      <span class="xs muted" style=${{ width: '28px', textAlign: 'right' }}>${count}</span>
      <button type="button" class="btn btn-ghost sm" disabled=${!dirty} onClick=${() => app.saveFolder(f.id, v)}>Speichern</button>
      ${app.isAdmin() && html`<button type="button" class="more-btn" title="Ordner löschen" onClick=${() => app.deleteFolder(f)}><span class="ms s18">delete</span></button>`}
    </div>`;
}

function FoldersPanel({ app }) {
  const [n, setN] = useState({ name: '', icon: 'folder', hue: 200 });
  const add = e => { e.preventDefault(); if (!n.name.trim()) return; app.saveFolder(null, n).then(ok => ok && setN({ name: '', icon: 'folder', hue: 200 })); };
  return html`
    <div class="panel">
      <${PanelHead} title="Ordner" desc="Ordner strukturieren die Dokumentation. Icons sind Namen aus Material Symbols (z. B. lan, dns, router, storage, security)." />
      <div class="list-plain">
        ${app.state.folders.map(f => html`<${FolderRow} key=${f.id} app=${app} f=${f} count=${app.state.docs.filter(d => d.folder === f.id).length} />`)}
      </div>
      <form onSubmit=${add} style=${{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        <input class="input" style=${{ flex: '1 1 200px' }} placeholder="Neuer Ordner" value=${n.name} maxlength="60" onInput=${e => setN({ ...n, name: e.target.value })} />
        <input class="input mono" style=${{ width: '140px' }} placeholder="Icon" value=${n.icon} maxlength="40" onInput=${e => setN({ ...n, icon: e.target.value.trim() })} />
        <input type="range" min="0" max="360" value=${n.hue} onInput=${e => setN({ ...n, hue: Number(e.target.value) })} aria-label="Farbton" style=${{ width: '90px' }} />
        <div class="hue-swatch" style=${{ background: fcol(n.hue).color }}></div>
        <button class="btn btn-ghost md"><${Icon} name="create_new_folder" />Anlegen</button>
      </form>
    </div>`;
}

// ---------------- Papierkorb ----------------
function TrashPanel({ app }) {
  const [data, setData] = useState(null);
  const load = () => api('/docs/trash').then(setData).catch(e => app.flash(e.message, null, true));
  useEffect(() => { load(); }, [app.state.docs.length]);
  if (!data) return null;
  return html`
    <div class="panel">
      <${PanelHead} title="Papierkorb" desc=${`Gelöschte Dokumente werden nach ${data.retentionDays} Tagen endgültig entfernt.`} />
      ${data.docs.length === 0 ? html`<div class="small muted">Der Papierkorb ist leer.</div>` : html`
        <div class="list-plain">
          ${data.docs.map(d => html`
            <div>
              <${Icon} name="description" cls="s18 muted" />
              <div style=${{ flex: 1, minWidth: 0 }}><div style=${{ fontSize: '13px', fontWeight: 600 }}>${d.title}</div><div class="xs muted">gelöscht ${fmtDate(d.deleted)}</div></div>
              <button type="button" class="btn btn-ghost sm" onClick=${() => app.restoreDoc(d.id).then(load)}>Wiederherstellen</button>
              ${app.isAdmin() && html`<button type="button" class="btn btn-danger sm" onClick=${() => app.purgeDoc(d).then(load)}>Endgültig löschen</button>`}
            </div>`)}
        </div>`}
    </div>`;
}

// ---------------- Daten ----------------
function DataPanel({ app }) {
  const restoreRef = { current: null };
  return html`
    <div class="panel" style=${{ gap: '11px' }}>
      <${PanelHead} title="Daten" desc="Alle Dokumente werden zentral auf dem Server gespeichert (SQLite im Docker-Volume). Regelmäßige Exporte bzw. Volume-Backups werden empfohlen." />
      <div class="btn-row">
        <button type="button" class="btn btn-primary md" onClick=${() => app.exportMd()}><${Icon} name="download" />Alles als Markdown</button>
        <button type="button" class="btn btn-ghost md" onClick=${() => app.exportJson()}><${Icon} name="data_object" />JSON-Backup</button>
        ${app.canEdit() && html`<button type="button" class="btn btn-ghost md" onClick=${() => app.triggerImport()}><${Icon} name="upload_file" />.md importieren</button>`}
        ${app.isAdmin() && html`
          <button type="button" class="btn btn-ghost md" onClick=${() => restoreRef.current && restoreRef.current.click()}><${Icon} name="settings_backup_restore" />Backup einspielen</button>
          <input type="file" accept=".json,application/json" hidden ref=${el => { restoreRef.current = el; }} onChange=${e => { const f = e.target.files[0]; e.target.value = ''; if (f) app.restoreBackup(f); }} />
          <button type="button" class="btn btn-danger md" onClick=${() => app.loadSamples()}><${Icon} name="restart_alt" />Beispieldaten wiederherstellen</button>`}
      </div>
    </div>`;
}

export function SettingsPage({ app }) {
  return html`
    <div class="page g18 settings" data-screen-label="Einstellungen">
      <h1 class="h1">Einstellungen</h1>
      <${ProfilePanel} app=${app} />
      <${AppearancePanel} app=${app} />
      <${SecurityPanel} app=${app} />
      ${app.canEdit() && html`<${FoldersPanel} app=${app} />`}
      ${app.canEdit() && html`<${TrashPanel} app=${app} />`}
      <${DataPanel} app=${app} />
    </div>`;
}

// ================= Verwaltung (nur Admin) =================
function UserRow({ app, u, reload }) {
  const me = app.state.user.id === u.id;
  const patch = async body => { try { await api('/admin/users/' + u.id, { method: 'PATCH', body }); app.flash('Benutzer aktualisiert'); } catch (e) { app.flash(e.message, null, true); } reload(); };
  const resetPw = async () => {
    const pw = prompt(`Neues vorläufiges Passwort für „${u.username}“ (mind. ${app.state.passwordMinLength} Zeichen). Der Benutzer muss es bei der nächsten Anmeldung ändern:`);
    if (!pw) return;
    try { await api(`/admin/users/${u.id}/password`, { method: 'POST', body: { password: pw } }); reload(); app.flash('Passwort zurückgesetzt'); } catch (e) { app.flash(e.message, null, true); }
  };
  const act = async (path, method, msg, confirmMsg) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    try { await api(`/admin/users/${u.id}${path}`, { method }); reload(); app.flash(msg); } catch (e) { app.flash(e.message, null, true); }
  };
  const statusPill = u.status === 'active' ? (u.locked ? ['bad', 'Gesperrt'] : ['ok', 'Aktiv']) : u.status === 'pending' ? ['warn', 'Wartet'] : ['bad', 'Deaktiviert'];
  return html`
    <tr>
      <td><div style=${{ display: 'flex', alignItems: 'center', gap: '9px' }}>
        <div class="avatar">${(u.displayName || '?').split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase()}</div>
        <div><div style=${{ fontWeight: 600 }}>${u.displayName}${me && html` <span class="xs muted">(du)</span>`}</div><div class="xs muted mono">${u.username}</div></div>
      </div></td>
      <td><select class="input" style=${{ width: '140px', padding: '6px 8px' }} value=${u.role} onChange=${e => patch({ role: e.target.value })}>
        ${Object.entries(ROLE_LABEL).map(([v, l]) => html`<option value=${v}>${l}</option>`)}
      </select></td>
      <td><span class=${'pill ' + statusPill[0]}>${statusPill[1]}</span> ${u.totpEnabled && html`<span class="pill ok" title="Zwei-Faktor aktiv">2FA</span>`}</td>
      <td class="xs muted">${u.lastLoginAt ? fmtDate(u.lastLoginAt) : 'nie'}<br />${u.sessions} Sitzung(en)</td>
      <td class="r"><div style=${{ display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        ${u.status === 'pending' && html`<button type="button" class="btn btn-primary sm" onClick=${() => patch({ status: 'active' })}>Freischalten</button>`}
        ${u.locked && html`<button type="button" class="btn btn-ghost sm" onClick=${() => patch({ unlock: true })}>Entsperren</button>`}
        ${!me && u.status === 'active' && html`<button type="button" class="btn btn-ghost sm" onClick=${() => patch({ status: 'disabled' })}>Deaktivieren</button>`}
        ${!me && u.status === 'disabled' && html`<button type="button" class="btn btn-ghost sm" onClick=${() => patch({ status: 'active' })}>Aktivieren</button>`}
        <button type="button" class="btn btn-ghost sm" onClick=${resetPw}>Passwort</button>
        ${u.totpEnabled && html`<button type="button" class="btn btn-ghost sm" onClick=${() => act('/reset-2fa', 'POST', '2FA zurückgesetzt', `2FA für „${u.username}“ zurücksetzen?`)}>2FA zurücksetzen</button>`}
        ${!me && u.sessions > 0 && html`<button type="button" class="btn btn-ghost sm" onClick=${() => act('/sessions', 'DELETE', 'Sitzungen beendet')}>Abmelden</button>`}
        ${!me && html`<button type="button" class="btn btn-danger sm" onClick=${() => act('', 'DELETE', 'Benutzer gelöscht', `Benutzer „${u.username}“ endgültig löschen?`)}>Löschen</button>`}
      </div></td>
    </tr>`;
}

function CreateUser({ app, reload }) {
  const [f, setF] = useState({ username: '', displayName: '', password: '', role: 'editor' });
  const [err, setErr] = useState('');
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const submit = async e => {
    e.preventDefault(); setErr('');
    try { await api('/admin/users', { method: 'POST', body: f }); setF({ username: '', displayName: '', password: '', role: 'editor' }); reload(); app.flash('Benutzer angelegt'); }
    catch (x) { setErr(x.message); }
  };
  return html`
    <form class="panel" onSubmit=${submit}>
      <${PanelHead} title="Benutzer anlegen" desc="Der neue Benutzer muss das vorläufige Passwort bei der ersten Anmeldung ändern." />
      <div class="form-grid">
        <label class="field"><span>Benutzername</span><input class="input" value=${f.username} onInput=${set('username')} required minlength="3" maxlength="32" autocomplete="off" /></label>
        <label class="field"><span>Anzeigename</span><input class="input" value=${f.displayName} onInput=${set('displayName')} maxlength="60" /></label>
        <label class="field"><span>Vorläufiges Passwort</span><input class="input" type="password" value=${f.password} onInput=${set('password')} required minlength=${app.state.passwordMinLength} autocomplete="new-password" /></label>
        <label class="field"><span>Rolle</span><select class="input" value=${f.role} onChange=${set('role')}>${Object.entries(ROLE_LABEL).map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></label>
      </div>
      ${err && html`<div class="err">${err}</div>`}
      <div><button class="btn btn-primary md"><${Icon} name="person_add" />Anlegen</button></div>
    </form>`;
}

function SystemSettings({ app }) {
  const [s, setS] = useState(null);
  useEffect(() => { api('/admin/settings').then(r => setS(r.settings)).catch(e => app.flash(e.message, null, true)); }, []);
  const save = async patch => {
    try { const r = await api('/admin/settings', { method: 'PUT', body: patch }); setS(r.settings); app.flash('Einstellungen gespeichert'); app.loadMeta(); }
    catch (e) { app.flash(e.message, null, true); }
  };
  if (!s) return null;
  return html`
    <div class="panel tight">
      <h2 class="h2 s16" style=${{ marginBottom: '8px' }}>Registrierung & System</h2>
      <${SetToggle} title="Selbstregistrierung erlauben" desc="Neue Benutzer können sich auf der Anmeldeseite selbst registrieren" on=${s.registrationEnabled} onClick=${() => save({ registrationEnabled: !s.registrationEnabled })} />
      <${SetToggle} title="Freischaltung erforderlich" desc="Selbst registrierte Konten müssen von einem Administrator freigeschaltet werden" on=${s.registrationRequiresApproval} onClick=${() => save({ registrationRequiresApproval: !s.registrationRequiresApproval })} />
      <div class="set-row static">
        <div><div class="t">Standardrolle</div><div class="s">Rolle für neu registrierte Benutzer</div></div>
        <div class="seg">${[['viewer', 'Leser'], ['editor', 'Bearbeiter']].map(([v, l]) => html`<button type="button" class=${s.defaultRole === v ? 'on' : ''} onClick=${() => save({ defaultRole: v })}>${l}</button>`)}</div>
      </div>
      <div class="set-row static">
        <div><div class="t">Prüfintervall</div><div class="s">Dokumente gelten nach so vielen Tagen ohne Änderung als veraltet</div></div>
        <input class="input" type="number" min="1" max="3650" style=${{ width: '90px' }} value=${s.staleDays} onChange=${e => save({ staleDays: Number(e.target.value) })} />
      </div>
    </div>`;
}

const AUDIT_LABEL = {
  'setup.admin_created': 'Administrator bei Ersteinrichtung angelegt', 'user.registered': 'Registriert', 'login.success': 'Anmeldung',
  'login.failed': 'Fehlgeschlagene Anmeldung', 'login.lockout': 'Konto nach Fehlversuchen gesperrt', 'login.locked': 'Anmeldung trotz Sperre versucht',
  'login.mfa_failed': 'Falscher 2FA-Code', logout: 'Abmeldung', 'user.password_changed': 'Passwort geändert', 'user.2fa_enabled': '2FA aktiviert',
  'user.2fa_disabled': '2FA deaktiviert', 'session.revoked': 'Sitzung beendet', 'session.revoked_all': 'Alle anderen Sitzungen beendet',
  'admin.user_created': 'Benutzer angelegt', 'admin.user_updated': 'Benutzer geändert', 'admin.password_reset': 'Passwort zurückgesetzt',
  'admin.2fa_reset': '2FA zurückgesetzt', 'admin.sessions_revoked': 'Sitzungen eines Benutzers beendet', 'admin.user_deleted': 'Benutzer gelöscht',
  'admin.settings_updated': 'Systemeinstellungen geändert', 'admin.backup_exported': 'Backup exportiert', 'admin.backup_restored': 'Backup eingespielt',
  'admin.sample_data': 'Beispieldaten geladen', 'doc.created': 'Dokument erstellt', 'doc.updated': 'Dokument geändert', 'doc.deleted': 'Dokument gelöscht',
  'doc.restored': 'Dokument wiederhergestellt', 'doc.purged': 'Dokument endgültig gelöscht', 'doc.reviewed': 'Als geprüft markiert',
  'doc.imported': 'Dokumente importiert', 'doc.revision_restored': 'Version wiederhergestellt', 'folder.created': 'Ordner angelegt',
  'folder.updated': 'Ordner geändert', 'folder.deleted': 'Ordner gelöscht',
};

function AuditLog({ app }) {
  const [entries, setEntries] = useState([]);
  const [more, setMore] = useState(true);
  const [filter, setFilter] = useState('');
  const load = async before => {
    try {
      const r = await api('/admin/audit?limit=200' + (before ? '&before=' + before : ''));
      setEntries(prev => (before ? prev.concat(r.entries) : r.entries)); setMore(r.entries.length === 200);
    } catch (e) { app.flash(e.message, null, true); }
  };
  useEffect(() => { load(); }, []);
  const fl = filter.trim().toLowerCase();
  const shown = fl ? entries.filter(e => [e.action, AUDIT_LABEL[e.action], e.username, e.target, e.ip, JSON.stringify(e.details)].join(' ').toLowerCase().includes(fl)) : entries;
  const sec = a => /failed|lock|disabled|reset|deleted|purged/.test(a);
  return html`
    <div class="panel">
      <div class="row-between"><${PanelHead} title="Audit-Log" desc="Sicherheitsrelevante Ereignisse und Änderungen." />
        <label class="search-box" style=${{ flex: '0 1 260px', padding: '8px 12px' }}><${Icon} name="search" /><input placeholder="Filtern …" value=${filter} onInput=${e => setFilter(e.target.value)} /></label>
      </div>
      <div class="table-scroll"><table class="utable">
        <thead><tr><th>Zeit</th><th>Ereignis</th><th>Benutzer</th><th>Ziel</th><th>IP</th></tr></thead>
        <tbody>${shown.map(e => html`
          <tr>
            <td class="xs muted" style=${{ whiteSpace: 'nowrap' }}>${fmtDateTime(e.ts)}</td>
            <td><span class=${sec(e.action) ? 'err' : ''} style=${{ fontWeight: 600 }}>${AUDIT_LABEL[e.action] || e.action}</span>
              ${e.details && e.details.title && html`<div class="xs muted">${e.details.title}</div>`}</td>
            <td class="small">${e.username || '–'}</td>
            <td class="xs muted mono">${e.target || ''}</td>
            <td class="xs muted mono">${e.ip || ''}</td>
          </tr>`)}</tbody>
      </table></div>
      ${more && !fl && entries.length > 0 && html`<div><button type="button" class="btn btn-ghost sm" onClick=${() => load(entries[entries.length - 1].id)}>Ältere laden</button></div>`}
    </div>`;
}

export function AdminPage({ app }) {
  const [tab, setTab] = useState('users');
  const [users, setUsers] = useState([]);
  const reload = () => api('/admin/users').then(r => { setUsers(r.users); app.setState({ pendingUsers: r.users.filter(u => u.status === 'pending').length }); }).catch(e => app.flash(e.message, null, true));
  useEffect(() => { reload(); }, []);
  return html`
    <div class="page g18" style=${{ maxWidth: '1100px' }} data-screen-label="Verwaltung">
      <div><h1 class="h1">Verwaltung</h1><p class="sub">Benutzer, Rollen und Systemeinstellungen.</p></div>
      <div class="tabs" role="tablist">
        ${[['users', 'Benutzer'], ['system', 'System'], ['audit', 'Audit-Log']].map(([k, l]) => html`<button type="button" role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}
      </div>
      ${tab === 'users' && html`
        <div class="panel">
          <${PanelHead} title=${`Benutzer (${users.length})`} desc="Leser: nur lesen · Bearbeiter: Dokumente & Ordner bearbeiten · Administrator: zusätzlich Benutzer- und Systemverwaltung." />
          <div class="table-scroll"><table class="utable">
            <thead><tr><th>Benutzer</th><th>Rolle</th><th>Status</th><th>Letzte Anmeldung</th><th class="r">Aktionen</th></tr></thead>
            <tbody>${users.map(u => html`<${UserRow} key=${u.id} app=${app} u=${u} reload=${reload} />`)}</tbody>
          </table></div>
        </div>
        <${CreateUser} app=${app} reload=${reload} />`}
      ${tab === 'system' && html`<${SystemSettings} app=${app} />`}
      ${tab === 'audit' && html`<${AuditLog} app=${app} />`}
    </div>`;
}
