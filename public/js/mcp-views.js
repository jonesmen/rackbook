import { html, useState, useEffect } from '/vendor/preact-htm.js';
import { api } from './api.js';
import { Icon, Toggle, fmtDate, fmtDateTime } from './util.js';

export const SCOPE_INFO = {
  read: { label: 'Lesen', desc: 'Dokumente suchen und lesen', icon: 'visibility' },
  write: { label: 'Schreiben', desc: 'Dokumente anlegen und bearbeiten (versioniert)', icon: 'edit_note' },
  delete: { label: 'Löschen', desc: 'Dokumente in den Papierkorb verschieben', icon: 'delete' },
  folders: { label: 'Ordner', desc: 'Neue Ordner anlegen', icon: 'create_new_folder' },
  files: { label: 'Dateien', desc: 'Dateien hochladen (Bilder, PDFs, Anhänge); lesen ist mit „Lesen“ erlaubt', icon: 'upload_file' },
};

function copyText(app, text, msg) {
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => app.flash(msg || 'Kopiert'));
  else app.flash('Bitte manuell markieren und kopieren', null, true);
}

const CodeBox = ({ app, label, text }) => html`
  <div style=${{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
    <div class="row-between"><span style=${{ fontSize: '12px', fontWeight: 600, color: 'var(--ink3)' }}>${label}</span>
      <button type="button" class="link-acc" style=${{ fontSize: '12px' }} onClick=${() => copyText(app, text)}>Kopieren</button></div>
    <pre class="md-pre" style=${{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>${text}</pre>
  </div>`;

// Anleitung zur Einbindung in verschiedene KI-Clients
export function ClientSetup({ app, endpoint, token }) {
  const t = token || '<DEIN_TOKEN>';
  const [tab, setTab] = useState('claude-code');
  const snippets = {
    'claude-code': ['Claude Code (Terminal)', `claude mcp add --transport http rackbook ${endpoint} \\\n  --header "Authorization: Bearer ${t}"`],
    'claude-desktop': ['Claude Desktop (claude_desktop_config.json)', JSON.stringify({ mcpServers: { rackbook: { command: 'npx', args: ['-y', 'mcp-remote', endpoint, '--header', 'Authorization:${AUTH}'], env: { AUTH: `Bearer ${t}` } } } }, null, 2)],
    generic: ['Andere Clients (Cursor, VS Code, LibreChat …)', JSON.stringify({ mcpServers: { rackbook: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${t}` } } } }, null, 2)],
  };
  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div class="seg" style=${{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
        ${[['claude-code', 'Claude Code'], ['claude-desktop', 'Claude Desktop'], ['generic', 'Andere']].map(([k, l]) => html`<button type="button" class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}
      </div>
      <${CodeBox} app=${app} label=${snippets[tab][0]} text=${snippets[tab][1]} />
      <div class="small muted">Danach z. B. sagen: „Dokumentiere meinen Traefik-Container in Rackbook“ oder die Vorlage <span class="mono">dienst_dokumentieren</span> wählen. Die KI erhält automatisch eine Anleitung, in welchem Ordner und in welcher Form sie dokumentieren soll.</div>
    </div>`;
}

// ---------- Einstellungen → KI-Zugriff (MCP) ----------
export function McpPanel({ app }) {
  const m = app.state.meta.mcp;
  const [tokens, setTokens] = useState(null);
  const [created, setCreated] = useState(null);
  const [f, setF] = useState({ name: '', scopes: ['read'], folders: [], expiresDays: '' });
  const [err, setErr] = useState('');
  const load = () => api('/me/mcp-tokens').then(r => setTokens(r.tokens)).catch(e => app.flash(e.message, null, true));
  useEffect(() => { if (m && m.enabled) load(); }, [m && m.enabled]);
  if (!m) return null;
  if (!m.enabled) {
    return html`<div class="panel"><div><h2 class="h2 s16">KI-Zugriff (MCP)</h2><p class="desc">Der MCP-Server ist deaktiviert.${app.isAdmin() ? ' Aktivieren unter Verwaltung → KI-Zugriff.' : ' Ein Administrator kann ihn in der Verwaltung aktivieren.'}</p></div></div>`;
  }
  const toggleScope = s => setF({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter(x => x !== s) : f.scopes.concat(s) });
  const toggleFolder = id => setF({ ...f, folders: f.folders.includes(id) ? f.folders.filter(x => x !== id) : f.folders.concat(id) });
  const create = async e => {
    e.preventDefault(); setErr('');
    try {
      const r = await api('/me/mcp-tokens', { method: 'POST', body: { ...f, expiresDays: f.expiresDays === '' ? undefined : Number(f.expiresDays) } });
      setCreated(r); setF({ name: '', scopes: ['read'], folders: [], expiresDays: '' }); load();
    } catch (x) { setErr(x.message); }
  };
  const revoke = async t => {
    if (!confirm(`Token „${t.name}“ widerrufen? Verbundene KI-Clients verlieren sofort den Zugriff.`)) return;
    try { await api('/me/mcp-tokens/' + t.id, { method: 'DELETE' }); load(); app.flash('Token widerrufen'); } catch (x) { app.flash(x.message, null, true); }
  };
  const expiryOpts = [[30, '30 Tage'], [90, '90 Tage'], [365, '1 Jahr'], [0, 'Unbegrenzt']].filter(([d]) => !m.maxTokenDays || (d > 0 && d <= m.maxTokenDays));
  return html`
    <div class="panel">
      <div><h2 class="h2 s16">KI-Zugriff (MCP)</h2>
        <p class="desc">Verbinde einen KI-Assistenten (Claude, ChatGPT, Cursor …) über das Model Context Protocol mit Rackbook, damit er für dich dokumentieren kann. Jedes Token handelt in deinem Namen – mit höchstens deinen Rechten.</p></div>
      <label class="field wide"><span>MCP-Endpunkt</span>
        <div class="copy-field"><input class="input" value=${m.endpoint} readonly onFocus=${e => e.target.select()} /><button type="button" class="btn btn-ghost sm" onClick=${() => copyText(app, m.endpoint)}><${Icon} name="content_copy" cls="s16" /></button></div>
      </label>

      ${created && html`
        <div class="notice" style=${{ flexDirection: 'column', gap: '10px', background: 'oklch(0.97 0.03 155)' }}>
          <div style=${{ fontWeight: 600 }}>Token „${created.info.name}“ erstellt – jetzt kopieren, es wird nur einmal angezeigt.</div>
          <div class="copy-field"><input class="input" value=${created.token} readonly onFocus=${e => e.target.select()} /><button type="button" class="btn btn-ghost sm" onClick=${() => copyText(app, created.token, 'Token kopiert')}><${Icon} name="content_copy" cls="s16" /></button></div>
          <${ClientSetup} app=${app} endpoint=${m.endpoint} token=${created.token} />
          <div><button type="button" class="btn btn-ghost sm" onClick=${() => setCreated(null)}>Fertig</button></div>
        </div>`}

      <div style=${{ fontSize: '13px', fontWeight: 600 }}>Deine Tokens</div>
      ${tokens && tokens.length === 0 && html`<div class="small muted">Noch keine Tokens.</div>`}
      <div class="list-plain">
        ${(tokens || []).map(t => html`
          <div>
            <${Icon} name="smart_toy" cls="s18 muted" />
            <div style=${{ flex: 1, minWidth: 0 }}>
              <div style=${{ fontSize: '13px', fontWeight: 600 }}>${t.name} <span class="xs muted mono">${t.prefix}…</span> ${t.expired && html`<span class="pill bad">abgelaufen</span>`}</div>
              <div class="xs muted">${t.scopes.map(s => SCOPE_INFO[s]?.label || s).join(', ')}${t.folders.length ? ` · nur ${t.folders.map(id => app.F(id).name).join(', ')}` : ''} · ${t.expiresAt ? 'gültig bis ' + fmtDate(t.expiresAt) : 'unbegrenzt'} · ${t.lastUsedAt ? 'zuletzt genutzt ' + fmtDateTime(t.lastUsedAt) : 'noch nie genutzt'}</div>
            </div>
            <button type="button" class="btn btn-danger sm" onClick=${() => revoke(t)}>Widerrufen</button>
          </div>`)}
      </div>

      <form onSubmit=${create} style=${{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid var(--line2)', paddingTop: '14px' }}>
        <div style=${{ fontSize: '13px', fontWeight: 600 }}>Neues Token</div>
        <div class="form-grid">
          <label class="field"><span>Name</span><input class="input" value=${f.name} onInput=${e => setF({ ...f, name: e.target.value })} placeholder="z. B. Claude Desktop" maxlength="60" required /></label>
          <label class="field"><span>Gültigkeit</span><select class="input" value=${f.expiresDays} onChange=${e => setF({ ...f, expiresDays: e.target.value })}>
            <option value="">Standard${m.maxTokenDays ? ` (${m.maxTokenDays} Tage)` : ' (unbegrenzt)'}</option>
            ${expiryOpts.map(([d, l]) => html`<option value=${d}>${l}</option>`)}
          </select></label>
        </div>
        <div>
          <div style=${{ fontSize: '12px', fontWeight: 600, color: 'var(--ink3)', marginBottom: '4px' }}>Rechte</div>
          ${Object.entries(SCOPE_INFO).map(([k, i]) => {
            const ok = m.grantable.includes(k);
            return html`<button type="button" class="set-row" disabled=${!ok || k === 'read'} style=${{ opacity: ok ? 1 : 0.45, cursor: ok && k !== 'read' ? 'pointer' : 'default' }} onClick=${() => ok && k !== 'read' && toggleScope(k)}>
              <div style=${{ display: 'flex', gap: '9px', alignItems: 'center' }}><${Icon} name=${i.icon} cls="s18 muted" /><div><div class="t">${i.label}</div><div class="s">${i.desc}${!ok ? ' – nicht verfügbar für deine Rolle oder vom Administrator deaktiviert' : ''}</div></div></div>
              <${Toggle} on=${f.scopes.includes(k)} /></button>`;
          })}
        </div>
        <div>
          <div style=${{ fontSize: '12px', fontWeight: 600, color: 'var(--ink3)', marginBottom: '6px' }}>Ordner (keine Auswahl = alle Ordner; Unterordner sind jeweils eingeschlossen)</div>
          <div class="tags-wrap">
            ${app.folderTreeList().map(({ f: fo }) => html`<button type="button" class=${'tag-chip' + (f.folders.includes(fo.id) ? ' sel-chip' : '')} onClick=${() => toggleFolder(fo.id)}>${f.folders.includes(fo.id) ? '✓ ' : ''}${app.folderPath(fo.id)}</button>`)}
          </div>
        </div>
        ${err && html`<div class="err">${err}</div>`}
        <div><button class="btn btn-primary md"><${Icon} name="key" />Token erstellen</button></div>
      </form>
    </div>`;
}

// ---------- Verwaltung → KI-Zugriff ----------
export function McpAdmin({ app }) {
  const [d, setD] = useState(null);
  const [g, setG] = useState('');
  const load = r => { setD(r); setG(r.settings.guidelines || ''); };
  useEffect(() => { api('/admin/mcp').then(load).catch(e => app.flash(e.message, null, true)); }, []);
  if (!d) return null;
  const s = d.settings;
  const save = async patch => {
    try { load(await api('/admin/mcp', { method: 'PUT', body: patch })); app.flash('Gespeichert'); app.loadMeta(); }
    catch (e) { app.flash(e.message, null, true); }
  };
  const revoke = async t => {
    if (!confirm(`Token „${t.name}“ von ${t.displayName} widerrufen?`)) return;
    try { const r = await api('/admin/mcp-tokens/' + t.id, { method: 'DELETE' }); setD({ ...d, tokens: r.tokens }); app.flash('Token widerrufen'); } catch (e) { app.flash(e.message, null, true); }
  };
  const Row = ({ k, title, desc }) => html`
    <button type="button" class="set-row" role="switch" aria-checked=${!!s[k]} onClick=${() => save({ [k]: !s[k] })}>
      <div><div class="t">${title}</div><div class="s">${desc}</div></div><${Toggle} on=${!!s[k]} /></button>`;
  return html`
    <div class="panel tight">
      <div class="row-between" style=${{ marginBottom: '8px' }}>
        <div><h2 class="h2 s16">KI-Zugriff (MCP-Server)</h2><p class="desc">Integrierter Model-Context-Protocol-Server unter <span class="mono">${d.endpoint}</span>. Benutzer erstellen persönliche Tokens unter Einstellungen → KI-Zugriff.</p></div>
        <span class=${'pill ' + (s.enabled ? 'ok' : 'warn')}>${s.enabled ? 'Aktiv' : 'Inaktiv'}</span>
      </div>
      <${Row} k="enabled" title="MCP-Server aktivieren" desc="Erlaubt KI-Assistenten den Zugriff über persönliche Tokens" />
      <${Row} k="allowViewerTokens" title="Leser dürfen Lese-Tokens erstellen" desc="Sonst nur Bearbeiter und Administratoren" />
      <${Row} k="allowWrite" title="Schreiben erlauben" desc="KI darf Dokumente anlegen und bearbeiten (jede Änderung wird versioniert)" />
      <${Row} k="allowDelete" title="Löschen erlauben" desc="KI darf Dokumente in den Papierkorb verschieben" />
      <${Row} k="allowFolders" title="Ordner anlegen erlauben" desc="KI darf neue Ordner erstellen" />
      <${Row} k="allowFiles" title="Datei-Uploads erlauben" desc="KI darf Bilder, PDFs und Anhänge hochladen (max. 20 MB, Limit aus Editor & Medien gilt zusätzlich). Lesen hochgeladener Dateien ist mit dem Leserecht möglich." />
      <div class="set-row static">
        <div><div class="t">Maximale Token-Laufzeit</div><div class="s">In Tagen, 0 = unbegrenzt</div></div>
        <input class="input" type="number" min="0" max="3650" style=${{ width: '90px' }} value=${s.maxTokenDays} onChange=${e => save({ maxTokenDays: Number(e.target.value) })} />
      </div>
      <div class="set-row static">
        <div><div class="t">Tag für KI-Änderungen</div><div class="s">Wird bei von der KI angelegten/geänderten Dokumenten ergänzt (leer = aus)</div></div>
        <input class="input" style=${{ width: '140px' }} value=${s.aiTag} onChange=${e => save({ aiTag: e.target.value })} />
      </div>
      <div class="set-row static">
        <div><div class="t">Rate-Limit</div><div class="s">Maximale Aufrufe pro Token und Minute</div></div>
        <input class="input" type="number" min="10" max="2000" style=${{ width: '90px' }} value=${s.rateLimitPerMinute} onChange=${e => save({ rateLimitPerMinute: Number(e.target.value) })} />
      </div>
    </div>

    <div class="panel">
      <div><h2 class="h2 s16">Hausregeln für die KI</h2><p class="desc">Eigene Vorgaben, die jede verbundene KI zusätzlich zur eingebauten Anleitung erhält (Markdown). Z. B. Namenskonventionen, Pflichtabschnitte, wo Zugangsdaten liegen.</p></div>
      <textarea class="input" rows="7" style=${{ fontFamily: 'var(--mono)', fontSize: '12.5px', resize: 'vertical' }} value=${g} onInput=${e => setG(e.target.value)} maxlength="8000"
        placeholder=${'- Hostnamen immer klein schreiben (z. B. pve-01)\n- Zugangsdaten liegen in Vaultwarden, Sammlung „Homelab“\n- Jeder Dienst braucht einen Abschnitt „## Backup“'}></textarea>
      <div><button type="button" class="btn btn-primary md" disabled=${g === (s.guidelines || '')} onClick=${() => save({ guidelines: g })}><${Icon} name="save" />Hausregeln speichern</button></div>
    </div>

    <div class="panel">
      <div><h2 class="h2 s16">Aktive Tokens (${d.tokens.length})</h2><p class="desc">Alle Tokens aller Benutzer. Rechte werden bei jeder Anfrage gegen Rolle und obige Einstellungen geprüft.</p></div>
      ${d.tokens.length === 0 ? html`<div class="small muted">Keine aktiven Tokens.</div>` : html`
        <div class="table-scroll"><table class="utable">
          <thead><tr><th>Token</th><th>Benutzer</th><th>Rechte</th><th>Zuletzt genutzt</th><th class="r"></th></tr></thead>
          <tbody>${d.tokens.map(t => html`
            <tr>
              <td><div style=${{ fontWeight: 600 }}>${t.name}</div><div class="xs muted mono">${t.prefix}…</div></td>
              <td class="small">${t.displayName}<div class="xs muted mono">${t.username}</div></td>
              <td class="xs">${t.scopes.join(', ')}${t.folders.length ? html`<div class="muted">nur: ${t.folders.join(', ')}</div>` : ''}</td>
              <td class="xs muted">${t.lastUsedAt ? fmtDateTime(t.lastUsedAt) : 'nie'}${t.lastUsedIp ? html`<div class="mono">${t.lastUsedIp}</div>` : ''}<div>${t.expiresAt ? (t.expired ? 'abgelaufen' : 'bis ' + fmtDate(t.expiresAt)) : 'unbegrenzt'}</div></td>
              <td class="r"><button type="button" class="btn btn-danger sm" onClick=${() => revoke(t)}>Widerrufen</button></td>
            </tr>`)}</tbody>
        </table></div>`}
    </div>

    <div class="panel">
      <div><h2 class="h2 s16">Was die KI kann</h2><p class="desc">Die KI erhält beim Verbinden eine Anleitung mit allen Ordnern, Tags, Markdown-Regeln, empfohlenen Strukturen und den Hausregeln.</p></div>
      <ul class="help-steps">
        <li><b>Lesen:</b> <code>rackbook_overview</code>, <code>search_documents</code>, <code>list_documents</code>, <code>get_document</code>, <code>list_open_todos</code></li>
        <li><b>Schreiben:</b> <code>create_document</code>, <code>append_to_document</code>, <code>replace_in_document</code>, <code>update_document</code> (mit Versionsprüfung)</li>
        <li><b>Löschen:</b> <code>delete_document</code> (Papierkorb) · <b>Ordner:</b> <code>create_folder</code></li>
        <li><b>Vorlagen:</b> <code>dienst_dokumentieren</code>, <code>host_dokumentieren</code>, <code>runbook_erstellen</code>, <code>dokumentation_pruefen</code></li>
      </ul>
    </div>`;
}
