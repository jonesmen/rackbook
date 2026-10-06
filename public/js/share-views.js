import { html, useState, useEffect } from '/vendor/preact-htm.js';
import { api } from './api.js';
import { Icon, Toggle, fmtDate, fmtDateTime, stop } from './util.js';

export const shareUrl = token => `${location.origin}/share#${token}`;

function copy(app, text) {
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => app.flash('Link kopiert'));
  else app.flash('Bitte den Link manuell markieren und kopieren', null, true);
}

const expiryLabel = s => (s.expired ? 'abgelaufen' : s.expiresAt ? `bis ${fmtDateTime(s.expiresAt)}` : 'unbegrenzt');

function ShareRow({ app, s, onRevoke, showOwner, showTitle }) {
  return html`
    <div>
      <${Icon} name=${s.kind === 'folder' ? 'folder_shared' : 'link'} cls="s18 muted" />
      <div style=${{ flex: 1, minWidth: 0 }}>
        <div style=${{ fontSize: '13px', fontWeight: 600 }}>
          ${showTitle ? html`<button type="button" class="link-plain" onClick=${() => app.openShareTarget(s)}>${s.title}</button>` : (s.label || 'Freigabe')}
          ${showTitle && s.label && html` <span class="xs muted">· ${s.label}</span>`}
          ${s.hasPassword && html` <span class="pill" title="Passwortgeschützt"><span class="ms s15">lock</span></span>`}
          ${s.expired && html` <span class="pill bad">abgelaufen</span>`}
        </div>
        <div class="xs muted">${s.kind === 'folder' ? (s.includeChildren ? 'Ordner inkl. Unterordner' : 'Ordner') : (s.includeChildren ? 'Seite inkl. Unterseiten' : 'Nur diese Seite')}
          · ${expiryLabel(s)} · ${s.viewCount}× aufgerufen${s.lastViewedAt ? `, zuletzt ${fmtDate(s.lastViewedAt)}` : ''}${showOwner ? ` · von ${s.displayName}` : ''} · erstellt ${fmtDate(s.createdAt)}</div>
      </div>
      ${!s.expired && html`<button type="button" class="btn btn-danger sm" onClick=${() => onRevoke(s)}>Widerrufen</button>`}
    </div>`;
}

// ---------- Teilen-Dialog für eine Seite oder einen Ordner ----------
export function ShareDialog({ app, item, onClose }) {
  const cfg = app.state.meta.sharing || {};
  const admin = app.isAdmin();
  const [info, setInfo] = useState(null);
  const [created, setCreated] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const steps = [1, 7, 30, 90, 365].filter(d => admin || !cfg.maxDays || d <= cfg.maxDays);
  if (cfg.maxDays && !steps.includes(cfg.maxDays) && !admin) steps.push(cfg.maxDays);
  const [f, setF] = useState({ includeChildren: true, expiresDays: String(cfg.defaultDays ?? 7), password: '', label: '' });
  const load = () => api(`/shares/item?kind=${item.kind}&id=${encodeURIComponent(item.id)}`).then(setInfo).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  const create = async e => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const r = await api('/shares', { method: 'POST', body: { kind: item.kind, target: item.id, includeChildren: f.includeChildren, expiresDays: Number(f.expiresDays), password: f.password || undefined, label: f.label || undefined } });
      setCreated({ url: shareUrl(r.token), share: r.share });
      setF({ ...f, password: '', label: '' });
      load();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const revoke = async s => {
    if (!confirm('Freigabe widerrufen? Der Link funktioniert danach sofort nicht mehr.')) return;
    try { await api('/shares/' + s.id, { method: 'DELETE' }); app.flash('Freigabe widerrufen'); load(); } catch (x) { setErr(x.message); }
  };
  const childLabel = item.kind === 'folder' ? 'Unterordner einschließen' : 'Unterseiten einschließen';
  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="Teilen" onClick=${stop}>
        <div class="modal-head"><h2 class="h2">Teilen: ${item.title}</h2><button type="button" class="ms close-btn" aria-label="Schließen" onClick=${onClose}>close</button></div>
        ${!cfg.enabled ? html`<div class="notice"><${Icon} name="info" />Das Teilen per Link ist vom Administrator deaktiviert.</div>` : !info ? html`<div class="small muted">Wird geladen …</div>` : html`
          <div style=${{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div class="notice"><${Icon} name="shield" /><div>Jeder mit dem Link kann ${item.kind === 'folder' ? 'diesen Ordner' : 'diese Seite'} <b>ohne Konto lesen</b> – nicht bearbeiten. Der Link wird nur einmal angezeigt und lässt sich jederzeit widerrufen.${!admin ? ' Es werden nur von dir erstellte Seiten geteilt.' : ''}</div></div>
            ${info.status && info.status.inherited > 0 && html`<div class="notice"><${Icon} name="public" />Dieser Inhalt ist bereits über eine übergeordnete Freigabe öffentlich erreichbar.</div>`}

            ${created && html`
              <div class="notice" style=${{ flexDirection: 'column', gap: '8px', background: 'oklch(0.97 0.03 155)' }}>
                <div style=${{ fontWeight: 600 }}>Link erstellt – jetzt kopieren, er wird nicht noch einmal angezeigt.</div>
                <div class="share-link"><input class="input" value=${created.url} readonly onFocus=${e => e.target.select()} /><button type="button" class="btn btn-primary sm" onClick=${() => copy(app, created.url)}><${Icon} name="content_copy" cls="s16" />Kopieren</button></div>
                <div class="xs muted">${expiryLabel(created.share)}${created.share.hasPassword ? ' · Passwort separat mitteilen' : ''}</div>
              </div>`}

            ${info.shares.length > 0 && html`
              <div><div style=${{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>Aktive Freigaben</div>
                <div class="list-plain">${info.shares.map(s => html`<${ShareRow} app=${app} s=${s} onRevoke=${revoke} showOwner=${admin} />`)}</div></div>`}

            ${info.canShare ? html`
              <form onSubmit=${create} style=${{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid var(--line2)', paddingTop: '14px' }}>
                <div style=${{ fontSize: '13px', fontWeight: 600 }}>Neuen Link erstellen</div>
                ${item.hasChildren && html`<button type="button" class="set-row" role="switch" aria-checked=${f.includeChildren} onClick=${() => setF({ ...f, includeChildren: !f.includeChildren })}>
                  <div><div class="t">${childLabel}</div><div class="s">${item.kind === 'folder' ? 'Alle Unterordner und deren Seiten sind mit dem Link sichtbar' : 'Alle Unterseiten sind mit dem Link sichtbar'}</div></div><${Toggle} on=${f.includeChildren} /></button>`}
                <div class="form-grid">
                  <label class="field"><span>Gültigkeit</span>
                    <select class="input" value=${f.expiresDays} onChange=${e => setF({ ...f, expiresDays: e.target.value })}>
                      ${steps.map(d => html`<option value=${d}>${d === 1 ? '1 Tag' : d === 365 ? '1 Jahr' : `${d} Tage`}${admin && cfg.maxDays && d > cfg.maxDays ? ' (über Maximum)' : ''}</option>`)}
                      ${(admin || !cfg.maxDays) && html`<option value="0">Unbegrenzt${admin && cfg.maxDays ? ' (über Maximum)' : ''}</option>`}
                    </select></label>
                  <label class="field"><span>Passwort ${cfg.requirePassword ? '(Pflicht)' : '(optional)'}</span>
                    <input class="input" type="password" value=${f.password} onInput=${e => setF({ ...f, password: e.target.value })} autocomplete="new-password" minlength="6" required=${!!cfg.requirePassword} placeholder="mind. 6 Zeichen" /></label>
                  <label class="field"><span>Notiz (optional)</span>
                    <input class="input" value=${f.label} onInput=${e => setF({ ...f, label: e.target.value })} maxlength="80" placeholder="z. B. für Dienstleister" /></label>
                </div>
                ${admin && cfg.maxDays > 0 && html`<div class="xs muted">Maximum für Benutzer: ${cfg.maxDays} Tage – als Administrator kannst du es überschreiben.</div>`}
                ${err && html`<div class="err">${err}</div>`}
                <div><button class="btn btn-primary md" disabled=${busy}><${Icon} name="add_link" />Link erstellen</button></div>
              </form>` : html`<div class="small muted">Du kannst nur selbst erstellte Inhalte teilen.</div>`}
          </div>`}
      </div>
    </div>`;
}

// ---------- Einstellungen → Geteilte Links ----------
export function SharesPanel({ app }) {
  const cfg = app.state.meta.sharing || {};
  const [list, setList] = useState(null);
  const load = () => api('/shares').then(r => setList(r.shares)).catch(e => app.flash(e.message, null, true));
  useEffect(() => { load(); }, []);
  if (!list) return null;
  if (!list.length && (!cfg.enabled || !app.canEdit())) return null;
  const revoke = async s => {
    if (!confirm(`Freigabe „${s.title}“ widerrufen?`)) return;
    try { await api('/shares/' + s.id, { method: 'DELETE' }); app.flash('Freigabe widerrufen'); load(); } catch (e) { app.flash(e.message, null, true); }
  };
  const active = list.filter(s => !s.expired), expired = list.filter(s => s.expired);
  return html`
    <div class="panel">
      <div><h2 class="h2 s16">Geteilte Links</h2>
        <p class="desc">Deine öffentlichen Freigaben. Teilen über das <span class="ms s15">share</span>-Symbol in einem Dokument oder Ordner.${cfg.maxDays ? ` Links sind höchstens ${cfg.maxDays} Tage gültig.` : ''}</p></div>
      ${active.length === 0 ? html`<div class="small muted">Du hast derzeit nichts öffentlich geteilt.</div>` : html`
        <div class="list-plain">${active.map(s => html`<${ShareRow} app=${app} s=${s} onRevoke=${revoke} showTitle=${true} />`)}</div>`}
      ${expired.length > 0 && html`<details><summary class="small muted" style=${{ cursor: 'pointer' }}>${expired.length} abgelaufene Freigabe(n)</summary>
        <div class="list-plain">${expired.map(s => html`<${ShareRow} app=${app} s=${s} onRevoke=${revoke} showTitle=${true} />`)}</div></details>`}
    </div>`;
}

// ---------- Verwaltung → Freigaben ----------
export function SharesAdmin({ app }) {
  const [d, setD] = useState(null);
  const load = () => api('/admin/shares').then(setD).catch(e => app.flash(e.message, null, true));
  useEffect(() => { load(); }, []);
  if (!d) return null;
  const s = d.settings;
  const save = async patch => {
    try { const r = await api('/admin/shares/settings', { method: 'PUT', body: patch }); setD({ ...d, settings: r.settings }); app.flash('Gespeichert'); app.loadMeta(); }
    catch (e) { app.flash(e.message, null, true); }
  };
  const revoke = async x => {
    if (!confirm(`Freigabe „${x.title}“ von ${x.displayName} widerrufen?`)) return;
    try { const r = await api('/admin/shares/' + x.id, { method: 'DELETE' }); setD({ ...d, shares: r.shares }); app.flash('Freigabe widerrufen'); } catch (e) { app.flash(e.message, null, true); }
  };
  const Row = ({ k, title, desc }) => html`
    <button type="button" class="set-row" role="switch" aria-checked=${!!s[k]} onClick=${() => save({ [k]: !s[k] })}>
      <div><div class="t">${title}</div><div class="s">${desc}</div></div><${Toggle} on=${!!s[k]} /></button>`;
  return html`
    <div class="panel tight">
      <div class="row-between" style=${{ marginBottom: '8px' }}>
        <div><h2 class="h2 s16">Teilen per Link</h2><p class="desc">Öffentliche, nur lesende Links für Seiten und Ordner – ohne Konto.</p></div>
        <span class=${'pill ' + (s.enabled ? 'ok' : 'warn')}>${s.enabled ? 'Aktiv' : 'Inaktiv'}</span>
      </div>
      <${Row} k="enabled" title="Teilen per Link erlauben" desc="Ausschalten sperrt sofort auch alle bestehenden Links" />
      <${Row} k="allowEditors" title="Bearbeiter dürfen teilen" desc="Nur selbst erstellte Seiten und Ordner; Administratoren dürfen alles teilen" />
      <${Row} k="requirePassword" title="Passwort vorschreiben" desc="Jeder neue Link braucht ein Passwort" />
      <div class="set-row static">
        <div><div class="t">Maximale Gültigkeit</div><div class="s">In Tagen, 0 = unbegrenzt. Administratoren können das beim Teilen überschreiben.</div></div>
        <input class="input" type="number" min="0" max="3650" style=${{ width: '90px' }} value=${s.maxDays} onChange=${e => save({ maxDays: Number(e.target.value) })} />
      </div>
      <div class="set-row static">
        <div><div class="t">Standard-Gültigkeit</div><div class="s">Vorauswahl beim Erstellen eines Links (Tage)</div></div>
        <input class="input" type="number" min="1" max="3650" style=${{ width: '90px' }} value=${s.defaultDays} onChange=${e => save({ defaultDays: Number(e.target.value) })} />
      </div>
    </div>
    <div class="panel">
      <div><h2 class="h2 s16">Aktive Freigaben (${d.shares.length})</h2><p class="desc">Alle öffentlichen Links aller Benutzer. In der Benutzerliste lassen sich alle Freigaben eines Benutzers auf einmal widerrufen.</p></div>
      ${d.shares.length === 0 ? html`<div class="small muted">Derzeit ist nichts öffentlich geteilt.</div>` : html`
        <div class="list-plain">${d.shares.map(x => html`<${ShareRow} app=${app} s=${x} onRevoke=${revoke} showOwner=${true} showTitle=${true} />`)}</div>`}
    </div>`;
}
