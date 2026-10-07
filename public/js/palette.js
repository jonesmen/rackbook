// Schnellsuche / Befehlspalette (Strg+K): Dokumente, Ordner, Inventar und Befehle
import { html, Component } from '/vendor/preact-htm.js';
import { fmtDate } from './util.js';

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
// Trefferqualität: Anfang > Wortanfang > enthalten > alle Wörter enthalten
function score(text, q) {
  const t = norm(text);
  if (!q) return 1;
  if (t.startsWith(q)) return 100;
  if (new RegExp('(^|[\\s/._-])' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(t)) return 70;
  if (t.includes(q)) return 50;
  const words = q.split(/\s+/).filter(Boolean);
  return words.length > 1 && words.every(w => t.includes(w)) ? 30 : 0;
}

export const KIND_ICON = { host: 'dns', vm: 'computer', container: 'deployed_code', device: 'router', service: 'apps', network: 'lan' };

export class CommandPalette extends Component {
  state = { q: '', sel: 0 };
  inputRef = { current: null };
  listRef = { current: null };
  componentDidMount() { setTimeout(() => this.inputRef.current && this.inputRef.current.focus(), 0); }
  items() {
    const { app } = this.props;
    const s = app.state;
    const q = norm(this.state.q.trim());
    const out = [];
    const cmd = (label, icon, run, kw = '', hint = '') => {
      const sc = q ? Math.max(score(label, q), score(kw, q) * 0.8) : 5;
      if (sc > 0) out.push({ group: 'Befehle', label, icon, run, hint, sc: sc + 1 });
    };
    const canEdit = app.canEdit();
    if (canEdit) {
      cmd('Neues Dokument', 'note_add', () => app.newDocument(), 'neu anlegen erstellen seite');
      if (s.page === 'doc' && s.docId) cmd('Unterseite anlegen', 'subdirectory_arrow_right', () => app.newDocument(null, s.docId), 'neu kind');
      cmd('Neuer Inventar-Eintrag', 'add_box', () => app.go('inventory', { assetId: 'new' }), 'host server vm container netzwerk gerät');
    }
    cmd('Dashboard', 'dashboard', () => app.go('dashboard'), 'start übersicht');
    cmd('Dokumente', 'article', () => app.go('docs', { folder: null, tag: null, q: '' }), 'alle liste');
    cmd('Inventar', 'inventory_2', () => app.go('inventory', { assetId: null }), 'hosts server ip netzwerke');
    cmd('IP-Belegung', 'lan', () => app.go('inventory', { assetId: null, invTab: 'ips' }), 'ip adressen frei netz vlan');
    if (canEdit) cmd('Vorlagen verwalten', 'library_books', () => app.openTemplatesSettings(), 'template');
    cmd('Benachrichtigungen', 'notifications', () => app.go('notifications'), 'veraltet prüfen');
    cmd('Einstellungen', 'settings', () => app.go('settings'), 'profil passwort');
    if (app.isAdmin()) cmd('Verwaltung', 'admin_panel_settings', () => app.go('admin'), 'admin benutzer system');
    if (this.state.q.trim()) out.push({ group: 'Befehle', label: `Volltextsuche nach „${this.state.q.trim()}“`, icon: 'search', run: () => app.go('search', { sq: this.state.q.trim() }), sc: 2 });

    for (const d of s.docs) {
      const path = app.folderPath(d.folder);
      const sc = q ? Math.max(score(d.title, q) * 1.2, score(d.tags.join(' '), q) * 0.6, score(path, q) * 0.4) : 0;
      if (q && sc <= 0) continue;
      out.push({ group: 'Dokumente', label: d.title, icon: app.docChildren(d.id).length ? 'auto_stories' : 'description', hint: `${path} · ${fmtDate(d.updated)}`, sc: (q ? sc : 10) + d.updated / 1e13, run: () => app.go('doc', { docId: d.id }) });
    }
    for (const f of s.folders) {
      const sc = q ? score(f.name, q) : 0;
      if (!q || sc <= 0) continue;
      out.push({ group: 'Ordner', label: app.folderPath(f.id), icon: f.icon, sc, run: () => app.go('docs', { folder: f.id, tag: null, q: '' }) });
    }
    for (const a of s.assets || []) {
      const ips = a.ips.map(i => i.address).join(' ');
      const sc = q ? Math.max(score(a.name, q), ips.split(' ').some(ip => ip.startsWith(q)) ? 90 : 0, score(a.data.cidr || '', q)) : 0;
      if (!q || sc <= 0) continue;
      out.push({ group: 'Inventar', label: a.name, icon: KIND_ICON[a.kind] || 'inventory_2', hint: [ips, a.data.cidr].filter(Boolean).join(' · '), sc, run: () => app.go('inventory', { assetId: a.id }) });
    }
    const order = ['Befehle', 'Dokumente', 'Ordner', 'Inventar'];
    const groups = order.map(g => out.filter(x => x.group === g).sort((a, b) => b.sc - a.sc).slice(0, g === 'Dokumente' ? 12 : 8));
    // Ohne Suchbegriff: zuletzt geänderte Dokumente zuerst, Befehle danach
    return q ? groups.flat().sort((a, b) => (b.sc - a.sc) || order.indexOf(a.group) - order.indexOf(b.group)) : [...groups[1].slice(0, 8), ...groups[0]];
  }
  run(it) {
    this.props.onClose();
    if (it) it.run();
  }
  onKey = (e, items) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); this.setState({ sel: Math.min(items.length - 1, this.state.sel + 1) }, () => this.scroll()); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.setState({ sel: Math.max(0, this.state.sel - 1) }, () => this.scroll()); }
    else if (e.key === 'Enter') { e.preventDefault(); this.run(items[this.state.sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); this.props.onClose(); }
  };
  scroll() { const el = this.listRef.current && this.listRef.current.querySelector('.pal-item.sel'); if (el) el.scrollIntoView({ block: 'nearest' }); }
  render({ onClose }, { q, sel }) {
    const items = this.items();
    let last = null;
    return html`
      <div class="overlay pal-overlay" onMouseDown=${e => { if (e.target === e.currentTarget) onClose(); }}>
        <div class="pal" role="dialog" aria-modal="true" aria-label="Schnellsuche">
          <div class="pal-search"><span class="ms">search</span>
            <input ref=${this.inputRef} value=${q} placeholder="Dokumente, Ordner, Inventar oder Befehle suchen …" aria-label="Suche"
              onInput=${e => this.setState({ q: e.target.value, sel: 0 })} onKeyDown=${e => this.onKey(e, items)} />
            <kbd>Esc</kbd>
          </div>
          <div class="pal-list" ref=${this.listRef}>
            ${items.map((it, k) => {
              const head = it.group !== last ? html`<div class="menu-label pal-group">${(q.trim() || it.group !== 'Dokumente' ? it.group : 'Zuletzt geändert').toUpperCase()}</div>` : null;
              last = it.group;
              return html`${head}<button type="button" class=${'pal-item' + (k === sel ? ' sel' : '')} onMouseMove=${() => { if (this.state.sel !== k) this.setState({ sel: k }); }} onClick=${() => this.run(it)}>
                <span class="ms">${it.icon}</span><span class="pal-l">${it.label}</span>${it.hint && html`<span class="pal-h">${it.hint}</span>`}</button>`;
            })}
            ${!items.length && html`<div class="md-empty pal-none">Nichts gefunden.</div>`}
          </div>
          <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> auswählen</span><span><kbd>Enter</kbd> öffnen</span><span><kbd>Strg</kbd>+<kbd>K</kbd> jederzeit</span></div>
        </div>
      </div>`;
  }
}
