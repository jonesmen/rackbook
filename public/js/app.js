import { html, render, Component } from '/vendor/preact-htm.js';
import { api, setCsrf, setUnauthorizedHandler, ApiError } from './api.js';
import { md, plain, excerpt } from './md.js';
import {
  DAY, ACCENTS, DEFAULT_SETTINGS, fcol, wordsOf, fmtWords, fmtDate, download, fileName, docMd, initials, Icon, Toggle, stop,
} from './util.js';
import { AuthScreen, ForcePasswordChange } from './auth-views.js';
import { SettingsPage, AdminPage } from './settings.js';

const CHEATS = [
  { syntax: '## Überschrift', label: 'Überschrift (## bis ####)' },
  { syntax: '**fett**  *kursiv*  ~~durch~~', label: 'Hervorhebung' },
  { syntax: '`10.0.20.11`', label: 'Inline-Code, IPs, Pfade' },
  { syntax: '```bash\nbefehl\n```', label: 'Code-Block mit Sprache' },
  { syntax: '- Punkt\n1. Schritt', label: 'Listen' },
  { syntax: '- [ ] Aufgabe', label: 'To-do – erscheint im Dashboard' },
  { syntax: '| Host | IP |\n|---|---|', label: 'Tabelle' },
  { syntax: '> Hinweis', label: 'Hinweis-Box' },
  { syntax: '[Text](https://…)', label: 'Link' },
  { syntax: '[Proxmox](/doc/<id>)', label: 'Link auf ein anderes Dokument' },
  { syntax: '---', label: 'Trennlinie' },
];

const UNKNOWN_FOLDER = { id: '', name: 'Ohne Ordner', icon: 'folder', hue: 250 };
const byDate = arr => arr.slice().sort((a, b) => b.updated - a.updated);

// ---------- Routing ----------
function parseUrl() {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  const qs = new URLSearchParams(location.search);
  let m;
  if (p === '/') return { page: 'dashboard' };
  if (p === '/docs') return { page: 'docs', folder: null, tag: qs.get('tag'), q: '' };
  if ((m = p.match(/^\/docs\/f\/([^/]+)$/))) return { page: 'docs', folder: decodeURIComponent(m[1]), tag: qs.get('tag'), q: '' };
  if ((m = p.match(/^\/doc\/([^/]+)\/edit$/))) return { page: 'edit', docId: decodeURIComponent(m[1]) };
  if ((m = p.match(/^\/doc\/([^/]+)$/))) return { page: 'doc', docId: decodeURIComponent(m[1]) };
  if (p === '/new') return { page: 'edit', docId: null, folder: qs.get('folder') };
  if (p === '/search') return { page: 'search', sq: qs.get('q') || '' };
  if (p === '/notifications') return { page: 'notifications' };
  if (p === '/settings') return { page: 'settings' };
  if (p === '/admin') return { page: 'admin' };
  return { page: 'dashboard' };
}
function urlFor(s) {
  const tag = s.tag ? '?tag=' + encodeURIComponent(s.tag) : '';
  switch (s.page) {
    case 'docs': return (s.folder ? '/docs/f/' + encodeURIComponent(s.folder) : '/docs') + tag;
    case 'doc': return '/doc/' + encodeURIComponent(s.docId);
    case 'edit': return s.draft && s.draft.id ? `/doc/${encodeURIComponent(s.draft.id)}/edit` : '/new';
    case 'search': return '/search' + (s.sq ? '?q=' + encodeURIComponent(s.sq) : '');
    case 'notifications': case 'settings': case 'admin': return '/' + s.page;
    default: return '/';
  }
}

class App extends Component {
  mainRef = { current: null };
  taRef = { current: null };
  fileRef = { current: null };
  state = {
    boot: 'loading', authState: null, user: null, passwordMinLength: 10,
    docs: [], folders: [], meta: { staleDays: 90 }, pendingUsers: 0,
    page: 'dashboard', folder: null, docId: null, q: '', sq: '', tag: null, filterOpen: false, menuId: null,
    showAllFolders: false, draft: null, draftBase: null, helpOpen: false, toast: null, toastErr: false, undoDocId: null,
    userMenu: false, rev: null, saving: false,
  };

  // ---------- Lebenszyklus ----------
  componentDidMount() {
    setUnauthorizedHandler(() => this.sessionLost());
    this.boot();
    window.addEventListener('popstate', this.onPop);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    window.addEventListener('focus', this.onFocus);
    this._poll = setInterval(() => this.refresh(), 120000);
  }
  componentWillUnmount() {
    window.removeEventListener('popstate', this.onPop);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    window.removeEventListener('focus', this.onFocus);
    clearInterval(this._poll);
  }
  async boot() {
    try {
      const st = await api('/auth/state');
      this.setState({ authState: st, passwordMinLength: st.passwordMinLength });
      if (st.user) { setCsrf(st.csrfToken); await this.enter(st.user); }
      else this.setState({ boot: 'auth' });
    } catch (e) {
      this.setState({ boot: 'error', bootError: e.message });
    }
  }
  async enter(user) {
    this.setState({ user });
    if (user.mustChangePassword) return this.setState({ boot: 'ready' });
    await this.loadAll();
    const route = parseUrl();
    if (location.pathname === '/' && (user.settings || {}).startPage === 'docs') route.page = 'docs';
    this.setState({ boot: 'ready' }, () => this.applyRoute(route, true));
  }
  async loadAll() {
    const [d, f, m] = await Promise.all([api('/docs'), api('/folders'), api('/meta')]);
    this._loaded = Date.now();
    this.setState({ docs: d.docs, folders: f.folders, meta: m });
    if (this.isAdmin()) api('/admin/users').then(r => this.setState({ pendingUsers: r.users.filter(u => u.status === 'pending').length })).catch(() => {});
  }
  loadMeta() { return api('/meta').then(meta => this.setState({ meta })).catch(() => {}); }
  async refresh() {
    if (this.state.boot !== 'ready' || !this.state.user || this.state.user.mustChangePassword) return;
    try {
      const [d, f] = await Promise.all([api('/docs'), api('/folders')]);
      this._loaded = Date.now();
      this.setState({ docs: d.docs, folders: f.folders });
    } catch { /* still */ }
  }
  onFocus = () => { if (Date.now() - (this._loaded || 0) > 30000) this.refresh(); };
  sessionLost() {
    if (this.state.boot !== 'ready') return;
    setCsrf(null);
    this.setState({ boot: 'auth', user: null, docs: [], draft: null, authState: { ...(this.state.authState || {}), setupRequired: false } });
  }
  async logout() {
    if (this.isDirty() && !confirm('Ungespeicherte Änderungen verwerfen und abmelden?')) return;
    let redirect = null;
    try { redirect = (await api('/auth/logout', { method: 'POST', body: {} })).redirect; } catch { /* egal */ }
    setCsrf(null);
    if (redirect) { location.assign(redirect); return; }
    history.replaceState(null, '', '/');
    this.setState({ boot: 'loading', user: null, docs: [], draft: null, userMenu: false });
    this.boot();
  }

  // ---------- Hilfen ----------
  settings() { return Object.assign({}, DEFAULT_SETTINGS, (this.state.user && this.state.user.settings) || {}); }
  canEdit() { return this.state.user && (this.state.user.role === 'editor' || this.state.user.role === 'admin'); }
  isAdmin() { return this.state.user && this.state.user.role === 'admin'; }
  F(id) { return this.state.folders.find(f => f.id === id) || { ...UNKNOWN_FOLDER, id }; }
  doc(id) { return this.state.docs.find(d => d.id === id); }
  isDirty() {
    const { draft, draftBase, page } = this.state;
    return page === 'edit' && draft && draftBase && ['title', 'folder', 'tags', 'content'].some(k => draft[k] !== draftBase[k]);
  }
  flash(msg, undoDocId, isErr) {
    clearTimeout(this._t);
    this.setState({ toast: msg, undoDocId: undoDocId || null, toastErr: !!isErr });
    this._t = setTimeout(() => this.setState({ toast: null, undoDocId: null }), isErr ? 5000 : 3200);
  }
  fail = e => {
    if (e instanceof ApiError && e.status === 401) return;
    this.flash(e.message || 'Unbekannter Fehler', null, true);
  };
  upsertDoc(d) { this.setState(s => ({ docs: s.docs.some(x => x.id === d.id) ? s.docs.map(x => (x.id === d.id ? d : x)) : [d].concat(s.docs) })); }
  setSettings(patch) {
    const user = { ...this.state.user, settings: { ...this.state.user.settings, ...patch } };
    this.setState({ user });
    api('/me', { method: 'PATCH', body: { settings: patch } }).catch(this.fail);
  }
  async updateMe(body, msg) {
    try { const r = await api('/me', { method: 'PATCH', body }); this.setState({ user: r.user }); if (msg) this.flash(msg); } catch (e) { this.fail(e); }
  }

  // ---------- Navigation ----------
  go(page, extra, replace, force) {
    if (!force && this.state.page === 'edit' && page !== 'edit' && this.isDirty() && !confirm('Ungespeicherte Änderungen verwerfen?')) return false;
    const next = Object.assign({ page, menuId: null, filterOpen: false, userMenu: false }, page !== 'edit' ? { draft: null, draftBase: null } : {}, extra || {});
    this.setState(next, () => {
      const url = urlFor(this.state);
      if (url !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState'](null, '', url);
    });
    if (this.mainRef.current) this.mainRef.current.scrollTop = 0;
    return true;
  }
  applyRoute(r, replace) {
    if (r.page === 'edit') {
      if (!this.canEdit()) return this.go('dashboard', null, true);
      if (r.docId) { const d = this.doc(r.docId); return d ? this.openEditor(d, null, replace) : this.go('dashboard', null, true); }
      return this.openEditor(null, r.folder, replace);
    }
    if (r.page === 'admin' && !this.isAdmin()) return this.go('dashboard', null, true);
    this.go(r.page, r, replace);
  }
  onPop = () => {
    if (this.state.boot !== 'ready') return;
    if (this.isDirty() && !confirm('Ungespeicherte Änderungen verwerfen?')) {
      history.pushState(null, '', urlFor(this.state));
      return;
    }
    this.setState({ draftBase: null, draft: null }, () => this.applyRoute(parseUrl(), true));
  };
  onBeforeUnload = e => { if (this.isDirty()) { e.preventDefault(); e.returnValue = ''; } };
  onKey = e => {
    if (e.key === 'Escape') {
      if (this.state.rev) return this.setState({ rev: null });
      if (this.state.helpOpen) return this.setState({ helpOpen: false });
      if (this.state.menuId || this.state.filterOpen || this.state.userMenu) this.setState({ menuId: null, filterOpen: false, userMenu: false });
    }
    if (this.state.page === 'edit' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); }
  };

  // ---------- Dokumentaktionen ----------
  openEditor(d, folder, replace) {
    const first = this.state.folders[0] ? this.state.folders[0].id : '';
    const draft = d
      ? { id: d.id, version: d.version, title: d.title, folder: d.folder, tags: d.tags.join(', '), content: d.content }
      : { id: null, title: '', folder: (folder && this.state.folders.some(f => f.id === folder)) ? folder : (this.state.folder || first), tags: '', content: '## Übersicht\n\n' };
    this.go('edit', { draft, draftBase: { ...draft } }, replace);
  }
  async save(force) {
    const dr = this.state.draft;
    if (!dr || this.state.saving) return;
    this.setState({ saving: true });
    const body = { title: dr.title, folder: dr.folder, tags: dr.tags, content: dr.content };
    try {
      const r = dr.id
        ? await api('/docs/' + encodeURIComponent(dr.id), { method: 'PUT', body: { ...body, version: force ? undefined : dr.version } })
        : await api('/docs', { method: 'POST', body });
      this.upsertDoc(r.doc);
      this.setState({ saving: false });
      this.go('doc', { docId: r.doc.id }, true, true);
      this.flash('Gespeichert');
    } catch (e) {
      this.setState({ saving: false });
      if (e.status === 409 && e.data.doc) {
        const other = e.data.doc;
        this.upsertDoc(other);
        if (confirm(`„${other.title}“ wurde inzwischen von ${other.updatedBy || 'jemand anderem'} geändert (${fmtDate(other.updated)}).\n\nOK = deine Version trotzdem speichern (überschreibt die Änderungen)\nAbbrechen = weiter bearbeiten`)) this.save(true);
        return;
      }
      this.fail(e);
    }
  }
  async togglePin(d) {
    try { const r = await api(`/docs/${encodeURIComponent(d.id)}/pin`, { method: 'POST', body: { pinned: !d.pinned } }); this.upsertDoc(r.doc); this.flash(d.pinned ? 'Nicht mehr angepinnt' : 'Auf dem Dashboard angepinnt'); } catch (e) { this.fail(e); }
  }
  async toggleBookmark(d) {
    try { const r = await api(`/docs/${encodeURIComponent(d.id)}/bookmark`, { method: 'POST', body: { bookmarked: !d.bookmarked } }); this.upsertDoc(r.doc); } catch (e) { this.fail(e); }
  }
  async removeDoc(d) {
    try {
      await api('/docs/' + encodeURIComponent(d.id), { method: 'DELETE' });
      this.setState(s => ({ docs: s.docs.filter(x => x.id !== d.id), menuId: null }));
      if (this.state.page === 'doc' && this.state.docId === d.id) this.go('docs', { folder: d.folder, tag: null, q: '' });
      this.flash('„' + d.title + '“ gelöscht', d.id);
    } catch (e) { this.fail(e); }
  }
  async restoreDoc(id) {
    try { const r = await api(`/docs/${encodeURIComponent(id)}/restore`, { method: 'POST', body: {} }); this.upsertDoc(r.doc); this.setState({ toast: null, undoDocId: null }); this.flash('Wiederhergestellt'); } catch (e) { this.fail(e); }
  }
  async purgeDoc(d) {
    if (!confirm(`„${d.title}“ endgültig löschen? Das kann nicht rückgängig gemacht werden.`)) return;
    try { await api(`/docs/${encodeURIComponent(d.id)}/purge`, { method: 'DELETE' }); this.flash('Endgültig gelöscht'); } catch (e) { this.fail(e); }
  }
  async review(d) {
    try { const r = await api(`/docs/${encodeURIComponent(d.id)}/review`, { method: 'POST', body: {} }); this.upsertDoc(r.doc); this.flash('Als geprüft markiert'); } catch (e) { this.fail(e); }
  }
  async toggleTodo(d, line, checked) {
    const text = (d.content.split('\n')[line] || '').replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '');
    try {
      const r = await api(`/docs/${encodeURIComponent(d.id)}/todo`, { method: 'POST', body: { line, text, checked } });
      this.upsertDoc(r.doc);
      if (checked) this.flash('Erledigt: ' + plain(text));
    } catch (e) { this.fail(e); if (e.status === 409) this.refresh(); }
  }
  async openRevisions(d) {
    try { const r = await api(`/docs/${encodeURIComponent(d.id)}/revisions`); this.setState({ rev: { docId: d.id, list: r.revisions, sel: null } }); } catch (e) { this.fail(e); }
  }
  async restoreRevision(d, rev) {
    if (!confirm(`Version ${rev.version} vom ${fmtDate(rev.created)} wiederherstellen? Der aktuelle Stand bleibt als Version erhalten.`)) return;
    try { const r = await api(`/docs/${encodeURIComponent(d.id)}/revisions/${rev.id}/restore`, { method: 'POST', body: {} }); this.upsertDoc(r.doc); this.setState({ rev: null }); this.flash('Version wiederhergestellt'); } catch (e) { this.fail(e); }
  }

  // ---------- Ordner ----------
  async saveFolder(id, v) {
    try {
      const r = id ? await api('/folders/' + encodeURIComponent(id), { method: 'PATCH', body: v }) : await api('/folders', { method: 'POST', body: v });
      this.setState(s => ({ folders: id ? s.folders.map(f => (f.id === id ? r.folder : f)) : s.folders.concat(r.folder) }));
      this.flash(id ? 'Ordner gespeichert' : 'Ordner angelegt');
      return true;
    } catch (e) { this.fail(e); return false; }
  }
  async deleteFolder(f) {
    if (!confirm(`Ordner „${f.name}“ löschen?`)) return;
    try { await api('/folders/' + encodeURIComponent(f.id), { method: 'DELETE' }); this.setState(s => ({ folders: s.folders.filter(x => x.id !== f.id) })); this.flash('Ordner gelöscht'); } catch (e) { this.fail(e); }
  }

  // ---------- Import / Export ----------
  triggerImport() { if (this.fileRef.current) this.fileRef.current.click(); }
  async readFiles(fileList) {
    const files = Array.from(fileList);
    const tooBig = files.find(f => f.size > (this.state.meta.maxDocBytes || 1048576));
    if (tooBig) return this.flash(`„${tooBig.name}“ ist zu groß.`, null, true);
    try {
      const payload = await Promise.all(files.map(async f => ({ name: f.name, text: await f.text() })));
      const r = await api('/import', { method: 'POST', body: { files: payload, folder: this.state.folder || undefined } });
      this.setState(s => ({ docs: r.docs.concat(s.docs) }));
      this.flash(r.docs.length + (r.docs.length === 1 ? ' Dokument' : ' Dokumente') + ' importiert');
    } catch (e) { this.fail(e); }
  }
  exportMd() {
    download('rackbook-export.md', byDate(this.state.docs).map(d => `# ${d.title}\n\n> Ordner: ${this.F(d.folder).name} · Tags: ${d.tags.join(', ')}\n\n${d.content}`).join('\n\n---\n\n'));
  }
  exportJson() {
    const data = {
      app: 'rackbook', format: 1, exportedAt: Date.now(), folders: this.state.folders,
      documents: this.state.docs.map(d => ({ id: d.id, title: d.title, folder: d.folder, tags: d.tags, content: d.content, pinned: d.pinned, created: d.created, updated: d.updated, reviewed: d.reviewed })),
    };
    download(`rackbook-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
  }
  async restoreBackup(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { return this.flash('Die Datei ist kein gültiges JSON.', null, true); }
    if (!data || !Array.isArray(data.documents)) return this.flash('Keine gültige Rackbook-Backup-Datei.', null, true);
    if (!confirm(`${data.documents.length} Dokumente aus dem Backup einspielen? Dokumente mit gleicher ID werden überschrieben (alte Stände bleiben als Version erhalten).`)) return;
    try { const r = await api('/admin/restore', { method: 'POST', body: data }); await this.loadAll(); this.flash(`Backup eingespielt: ${r.created} neu, ${r.updated} aktualisiert`); } catch (e) { this.fail(e); }
  }
  async loadSamples() {
    if (!confirm('Beispieldokumente laden? Bereits vorhandene Beispieldokumente werden ersetzt, eigene Dokumente bleiben unverändert.')) return;
    try { await api('/admin/sample-data', { method: 'POST', body: {} }); await this.loadAll(); this.flash('Beispieldaten wiederhergestellt'); } catch (e) { this.fail(e); }
  }

  // ---------- Editor ----------
  setDraft(patch) { this.setState({ draft: Object.assign({}, this.state.draft, patch) }); }
  insert(before, after, ph, linePrefix) {
    const ta = this.taRef.current, dr = this.state.draft; if (!ta || !dr) return;
    const v = dr.content, s = ta.selectionStart, e = ta.selectionEnd;
    let nv, cs, ce;
    if (linePrefix) {
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      nv = v.slice(0, ls) + before + v.slice(ls); cs = s + before.length; ce = e + before.length;
    } else {
      const sel = v.slice(s, e) || ph || '';
      nv = v.slice(0, s) + before + sel + (after || '') + v.slice(e); cs = s + before.length; ce = cs + sel.length;
    }
    this.setState({ draft: Object.assign({}, dr, { content: nv }) }, () => { ta.focus(); ta.setSelectionRange(cs, ce); });
  }

  // Klicks im gerenderten Markdown: Aufgaben abhaken, Code kopieren, interne Links.
  onArticleClick = (e, d) => {
    const t = e.target;
    const task = t.closest && t.closest('[data-task-line]');
    if (task && d && this.canEdit()) { this.toggleTodo(d, Number(task.dataset.taskLine), task.getAttribute('aria-checked') !== 'true'); return; }
    const copy = t.closest && t.closest('[data-copy]');
    if (copy) {
      const pre = copy.parentElement.querySelector('pre');
      const text = pre ? pre.textContent : '';
      const done = () => this.flash('In die Zwischenablage kopiert');
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => this.flash('Kopieren nicht möglich', null, true));
      else { const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); try { document.execCommand('copy'); done(); } catch { /* */ } sel.removeAllRanges(); }
      return;
    }
    const a = t.closest && t.closest('a[href]');
    if (a && !a.target) {
      const href = a.getAttribute('href');
      if (href.startsWith('#')) {
        e.preventDefault();
        const el = document.getElementById(href.slice(1));
        if (el) this.scrollToEl(el);
      } else if (href.startsWith('/')) {
        e.preventDefault();
        history.pushState(null, '', href);
        this.applyRoute(parseUrl());
      }
    }
  };
  onArticleKey = (e, d) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.taskLine !== undefined) { e.preventDefault(); this.onArticleClick(e, d); }
  };
  scrollToEl(el) {
    const main = this.mainRef.current;
    if (el && main) main.scrollTo({ top: el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 24, behavior: 'smooth' });
  }

  // =================== Render ===================
  render() {
    const s = this.state;
    if (s.boot === 'loading') return html`<div class="loading">Rackbook wird geladen …</div>`;
    if (s.boot === 'error') return html`<div class="loading">Fehler: ${s.bootError} – <button class="link-acc" onClick=${() => location.reload()}>Neu laden</button></div>`;
    if (s.boot === 'auth') return html`<${AuthScreen} state=${s.authState} onAuthed=${(user, csrf) => { setCsrf(csrf); this.setState({ boot: 'loading' }); this.enter(user); }} />`;
    if (s.user.mustChangePassword) {
      return html`<${ForcePasswordChange} user=${s.user} minLength=${s.passwordMinLength} onLogout=${() => this.logout()} onDone=${user => { this.setState({ boot: 'loading' }); this.enter(user); }} />`;
    }
    const st = this.settings();
    const acc = ACCENTS[st.accent] || ACCENTS.mint;
    document.documentElement.style.setProperty('--acc-soft', acc.soft);
    document.documentElement.style.setProperty('--acc-strong', acc.strong);
    const expanded = !st.sidebarCollapsed;
    const now = Date.now();
    const staleMs = (s.meta.staleDays || 90) * DAY;
    const touched = d => Math.max(d.updated, d.reviewed || 0);
    const staleDocs = s.docs.filter(d => now - touched(d) > staleMs).sort((a, b) => touched(a) - touched(b));

    return html`
      <div class="shell" onClick=${() => { if (s.menuId || s.filterOpen || s.userMenu) this.setState({ menuId: null, filterOpen: false, userMenu: false }); }}>
        ${this.renderSidebar(expanded, staleDocs)}
        <main class="main" ref=${this.mainRef}>
          <div class="container">
            ${s.page === 'dashboard' && this.renderDashboard()}
            ${s.page === 'docs' && this.renderDocs()}
            ${s.page === 'doc' && this.renderDoc()}
            ${s.page === 'edit' && s.draft && this.renderEditor(st)}
            ${s.page === 'search' && this.renderSearch()}
            ${s.page === 'notifications' && this.renderNotifications(staleDocs, touched)}
            ${s.page === 'settings' && html`<${SettingsPage} app=${this} />`}
            ${s.page === 'admin' && this.isAdmin() && html`<${AdminPage} app=${this} />`}
          </div>
        </main>
        <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" multiple hidden ref=${this.fileRef}
          onChange=${e => { if (e.target.files && e.target.files.length) this.readFiles(e.target.files); e.target.value = ''; }} />
        ${s.helpOpen && this.renderHelp()}
        ${s.rev && this.renderRevisions()}
        ${s.toast && html`
          <div class=${'toast' + (s.toastErr ? ' error' : '')} role="status" aria-live="polite">
            ${s.toast}
            ${s.undoDocId && html`<button type="button" onClick=${() => this.restoreDoc(s.undoDocId)}>Rückgängig</button>`}
          </div>`}
      </div>`;
  }

  headIcons() {
    return html`<div class="head-icons">
      <button type="button" class="icon-btn" title="Markdown-Hilfe" aria-label="Markdown-Hilfe" onClick=${() => this.setState({ helpOpen: true })}><span class="ms">help</span></button>
      <button type="button" class="icon-btn" title="Einstellungen" aria-label="Einstellungen" onClick=${() => this.go('settings')}><span class="ms">settings</span></button>
    </div>`;
  }
  globalSearchInput(cls, placeholder) {
    const s = this.state;
    return html`<label class=${cls}><span class="ms">search</span>
      <input type="search" value=${s.sq} placeholder=${placeholder} aria-label="Suche" onInput=${e => {
        const v = e.target.value;
        if (s.page !== 'search') {
          if (!v) return this.setState({ sq: v });
          this.go('search', { sq: v });
          if (cls !== 'sb-search') requestAnimationFrame(() => {
            const el = document.querySelector('.search-box.big input');
            if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
          });
        }
        else { this.setState({ sq: v }); history.replaceState(null, '', '/search' + (v ? '?q=' + encodeURIComponent(v) : '')); }
      }} /></label>`;
  }
  actionButtons() {
    if (!this.canEdit()) return null;
    return html`
      <button type="button" class="btn btn-ghost" onClick=${() => this.triggerImport()}><span class="ms">upload_file</span>Importieren</button>
      <button type="button" class="btn btn-primary" onClick=${() => this.openEditor(null, this.state.folder)}><span class="ms">add</span>Neues Dokument</button>`;
  }

  // ---------- Seitenleiste ----------
  renderSidebar(expanded, staleDocs) {
    const s = this.state, st = this.settings();
    const navItem = (label, icon, active, go, extra = {}) => html`
      <button type="button" class=${'nav-item' + (extra.folder ? ' folder' : '') + (active ? ' active' : '')} title=${label} onClick=${go}>
        <span class="ms">${icon}</span>
        ${expanded && html`<span class="grow">${label}</span>`}
        ${expanded && extra.count !== undefined && html`<span class="count">${extra.count}</span>`}
        ${extra.badge > 0 && html`<span class="badge">${extra.badge}</span>`}
      </button>`;
    const bms = s.docs.filter(d => d.bookmarked);
    return html`
      <aside class=${'sidebar' + (expanded ? '' : ' collapsed')}>
        <div class="sb-scroll">
          <div class="sb-head">
            <button type="button" class="brand" onClick=${() => this.go('dashboard')} title="Dashboard">
              <div class="logo">R</div>${expanded && html`<span class="brand-name">Rackbook</span>`}
            </button>
            ${expanded && html`<button type="button" class="icon-btn" title="Seitenleiste einklappen" onClick=${e => { stop(e); this.setSettings({ sidebarCollapsed: true }); }}><span class="ms s19">keyboard_double_arrow_left</span></button>`}
          </div>
          ${!expanded && html`<div style=${{ display: 'flex', justifyContent: 'center' }}><button type="button" class="icon-btn" title="Ausklappen" onClick=${e => { stop(e); this.setSettings({ sidebarCollapsed: false }); }}><span class="ms s19">keyboard_double_arrow_right</span></button></div>`}
          ${expanded ? this.globalSearchInput('sb-search', 'Globale Suche') : html`<button type="button" class="sb-search-btn" title="Suche" onClick=${() => this.go('search')}><span class="ms s16">search</span></button>`}
          <nav class="nav">
            ${navItem('Dashboard', 'dashboard', s.page === 'dashboard', () => this.go('dashboard'))}
            ${navItem('Dokumente', 'article', (s.page === 'docs' && !s.folder) || s.page === 'doc' || s.page === 'edit', () => this.go('docs', { folder: null, tag: null, q: '' }))}
            <button type="button" class="nav-item" title="Lesezeichen" onClick=${() => this.setSettings({ bmOpen: !st.bmOpen })}>
              <span class="ms">bookmark</span>
              ${expanded && html`<span class="grow">Lesezeichen</span><span class="ms chev">${st.bmOpen ? 'expand_less' : 'expand_more'}</span>`}
            </button>
            ${expanded && st.bmOpen && html`
              <div class="bm-list">
                ${bms.map(d => html`<button type="button" class="bm-item" title=${d.title} onClick=${() => this.go('doc', { docId: d.id })}>${d.title}</button>`)}
                ${bms.length === 0 && html`<div class="bm-empty">Noch keine Lesezeichen</div>`}
              </div>`}
          </nav>
          <div class="nav">
            ${expanded && html`<div class="nav-label">ORDNER</div>`}
            ${s.folders.map(f => navItem(f.name, f.icon, s.page === 'docs' && s.folder === f.id, () => this.go('docs', { folder: f.id, tag: null, q: '' }), { folder: true, count: s.docs.filter(d => d.folder === f.id).length }))}
          </div>
        </div>
        <div class="sb-foot">
          ${navItem('Einstellungen', 'settings', s.page === 'settings', () => this.go('settings'))}
          ${navItem('Benachrichtigungen', 'notifications', s.page === 'notifications', () => this.go('notifications'), { badge: staleDocs.length })}
          ${this.isAdmin() && navItem('Verwaltung', 'admin_panel_settings', s.page === 'admin', () => this.go('admin'), { badge: s.pendingUsers })}
          <button type="button" class="user-chip" title=${s.user.displayName} onClick=${e => { stop(e); this.setState({ userMenu: !s.userMenu, menuId: null, filterOpen: false }); }}>
            <div class="avatar">${initials(s.user.displayName)}</div>
            ${expanded && html`<span class="name">${s.user.displayName}</span><span class="ms">${s.userMenu ? 'expand_less' : 'expand_more'}</span>`}
          </button>
          ${s.userMenu && html`
            <div class="menu user-menu" onClick=${stop}>
              <div class="menu-label">${s.user.username.toUpperCase()}</div>
              <button type="button" class="menu-item" onClick=${() => this.go('settings')}><span class="ms">person</span>Profil & Sicherheit</button>
              ${this.isAdmin() && html`<button type="button" class="menu-item" onClick=${() => this.go('admin')}><span class="ms">group</span>Benutzerverwaltung</button>`}
              <div class="menu-sep"></div>
              <button type="button" class="menu-item danger" onClick=${() => this.logout()}><span class="ms">logout</span>Abmelden</button>
            </div>`}
        </div>
      </aside>`;
  }

  // ---------- Zeilen-Modell ----------
  row(d) {
    const f = this.F(d.folder);
    return { d, f, c: fcol(f.hue), fileName: fileName(d), words: fmtWords(wordsOf(d.content)), updatedLabel: fmtDate(d.updated), excerpt: excerpt(d.content) };
  }

  // ---------- Dashboard ----------
  renderDashboard() {
    const s = this.state;
    const docs = s.docs;
    const last = byDate(docs)[0];
    const pinned = byDate(docs.filter(d => d.pinned)).map(d => this.row(d));
    const recent = byDate(docs).slice(0, 5).map(d => this.row(d));
    const todos = [];
    byDate(docs).forEach(d => d.content.split('\n').forEach((l, li) => {
      const m = l.match(/^\s*[-*+]\s+\[ \]\s+(.*)$/);
      if (m) todos.push({ text: plain(m[1]), d, li });
    }));
    const canEdit = this.canEdit();
    return html`
      <div class="page" data-screen-label="Dashboard">
        <div class="page-head">
          <div><h1 class="h1">Übersicht</h1>
            <p class="sub">${docs.length} Dokumente in ${s.folders.length} Ordnern${last ? ` · zuletzt bearbeitet ${fmtDate(last.updated)}` : ''}</p></div>
          ${this.headIcons()}
        </div>
        <div class="toolbar">
          ${this.globalSearchInput('search-box', 'Dokumentation durchsuchen…')}
          <div class="spacer"></div>
          ${this.actionButtons()}
        </div>
        <div class="section">
          <div class="row-between"><h2 class="h2">Angepinnt</h2><button type="button" class="link-acc" onClick=${() => this.go('docs', { folder: null, tag: null, q: '' })}>Alle Dokumente</button></div>
          ${pinned.length ? html`
            <div class="grid-pinned">
              ${pinned.map(r => html`
                <button type="button" class="card click pin-card" onClick=${() => this.go('doc', { docId: r.d.id })}>
                  <div class="row-between" style=${{ width: '100%' }}>
                    <div class="ficon" style=${r.c}><span class="ms">${r.f.icon}</span></div>
                    <span class="ms s16" style=${{ color: '#c4c8cf' }}>keep</span>
                  </div>
                  <div><div class="title">${r.d.title}</div><div class="meta">${r.f.name} • ${r.updatedLabel}</div></div>
                  <p>${r.excerpt}</p>
                </button>`)}
            </div>` : html`<div class="card empty-note">Noch nichts angepinnt. Öffne ein Dokument und klicke auf <span class="ms s16">keep</span>, um es hier anzuzeigen.</div>`}
        </div>
        <div class="grid-2">
          <div class="section">
            <h2 class="h2">Zuletzt bearbeitet</h2>
            <div class="card list">
              ${recent.map(r => html`
                <button type="button" class="list-row" onClick=${() => this.go('doc', { docId: r.d.id })}>
                  <div class="ficon s30" style=${r.c}><span class="ms">description</span></div>
                  <div style=${{ flex: 1, minWidth: 0 }}><div class="t">${r.d.title}</div><div class="m">${r.f.name}</div></div>
                  <div class="d">${r.updatedLabel}</div>
                </button>`)}
              ${recent.length === 0 && html`<div class="empty-note">Noch keine Dokumente. ${canEdit ? 'Lege mit „Neues Dokument“ das erste an.' : ''}</div>`}
            </div>
          </div>
          <div class="section">
            <div class="row-between"><h2 class="h2">Offene To-dos</h2><span class="small muted" style=${{ fontWeight: 500 }}>${todos.length} offen</span></div>
            <div class="card list">
              ${todos.slice(0, 6).map(t => html`
                <div class="todo-row">
                  <button type="button" class="ms chk" title=${canEdit ? 'Erledigt' : 'Nur Bearbeiter können Aufgaben abhaken'} disabled=${!canEdit} onClick=${() => this.toggleTodo(t.d, t.li, true)}>check_box_outline_blank</button>
                  <div style=${{ flex: 1, minWidth: 0 }}>
                    <div class="tx">${t.text}</div>
                    <button type="button" class="doc" onClick=${() => this.go('doc', { docId: t.d.id })}>${t.d.title}</button>
                  </div>
                </div>`)}
              ${todos.length === 0 && html`<div class="empty-note">Keine offenen Punkte. Checklisten mit <code class="inline-code">- [ ]</code> erscheinen hier.</div>`}
            </div>
          </div>
        </div>
      </div>`;
  }

  // ---------- Dokumentliste ----------
  renderDocs() {
    const s = this.state, docs = s.docs;
    const ql = s.q.trim().toLowerCase();
    const listed = byDate(docs.filter(d => (!s.folder || d.folder === s.folder) && (!s.tag || d.tags.includes(s.tag))
      && (!ql || (d.title + ' ' + d.content + ' ' + d.tags.join(' ')).toLowerCase().includes(ql))));
    const tagCounts = {};
    docs.forEach(d => d.tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
    const tagNames = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a] || a.localeCompare(b));
    const title = s.folder ? this.F(s.folder).name : 'Dokumente';
    const showFolders = !s.folder && !s.tag && !ql;
    const folders = s.showAllFolders ? s.folders : s.folders.slice(0, 4);
    const canEdit = this.canEdit();
    return html`
      <div class="page g24" data-screen-label="Dokumente">
        <div class="page-head">
          <div style=${{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
            ${s.folder && html`<div class="crumbs"><button type="button" class="c" onClick=${() => this.go('docs', { folder: null, tag: null, q: '' })}>Dokumente</button><span class="ms">chevron_right</span><span class="cur">${title}</span></div>`}
            <h1 class="h1">${title}</h1>
          </div>
          ${this.headIcons()}
        </div>
        <div class="toolbar">
          <label class="search-box docs"><span class="ms">search</span>
            <input type="search" value=${s.q} onInput=${e => this.setState({ q: e.target.value })} placeholder="Dokumente durchsuchen…" aria-label="Dokumente durchsuchen" /></label>
          <div class="rel">
            <button type="button" class="filter-btn" aria-haspopup="true" aria-expanded=${s.filterOpen} onClick=${e => { stop(e); this.setState({ filterOpen: !s.filterOpen, menuId: null }); }}>Filtern nach<span class="ms">tune</span></button>
            ${s.filterOpen && html`
              <div class="menu filter" onClick=${stop}>
                <div class="menu-label">NACH TAG FILTERN</div>
                ${tagNames.map(t => html`<button type="button" class=${'menu-item between' + (s.tag === t ? ' sel' : '')} onClick=${() => this.go('docs', { folder: s.folder, q: s.q, tag: s.tag === t ? null : t }, true)}><span>#${t}</span><span class="xs faint">${tagCounts[t]}</span></button>`)}
                ${tagNames.length === 0 && html`<div class="bm-empty">Noch keine Tags</div>`}
              </div>`}
          </div>
          ${s.tag && html`<button type="button" class="chip-acc" onClick=${() => this.go('docs', { folder: s.folder, q: s.q, tag: null }, true)}>#${s.tag}<span class="ms">close</span></button>`}
          <div class="spacer"></div>
          ${this.actionButtons()}
        </div>
        ${showFolders && html`
          <div class="section g14">
            <div class="row-between"><h2 class="h2">Ordner</h2>
              ${s.folders.length > 4 && html`<button type="button" class="link-acc" onClick=${() => this.setState({ showAllFolders: !s.showAllFolders })}>${s.showAllFolders ? 'Weniger anzeigen' : 'Alle anzeigen'}</button>`}</div>
            <div class="grid-folders">
              ${folders.map(f => {
                const ds = docs.filter(d => d.folder === f.id);
                return html`
                  <button type="button" class="card click folder-card" onClick=${() => this.go('docs', { folder: f.id, tag: null, q: '' })}>
                    <div class="ficon s36" style=${fcol(f.hue)}><span class="ms">${f.icon}</span></div>
                    <div class="name">${f.name}</div>
                    <div class="meta">${ds.length} ${ds.length === 1 ? 'Dokument' : 'Dokumente'} • ${fmtWords(ds.reduce((n, d) => n + wordsOf(d.content), 0))}</div>
                  </button>`;
              })}
            </div>
          </div>`}
        <div class="section g14">
          <h2 class="h2">${s.folder || s.tag || ql ? `${listed.length} ${listed.length === 1 ? 'Dokument' : 'Dokumente'}` : 'Zuletzt bearbeitet'}</h2>
          <div class="card">
            <div class="dtable-head"><span>NAME</span><span>UMFANG</span><span>ZULETZT GEÄNDERT</span><span style=${{ textAlign: 'right' }}>AKTION</span></div>
            ${listed.map(d => {
              const r = this.row(d);
              const open = s.menuId === d.id;
              return html`
                <div class="dtable-row" key=${d.id}>
                  <button type="button" class="name" onClick=${() => this.go('doc', { docId: d.id })}>
                    <div class="ficon" style=${r.c}><span class="ms s18">description</span></div>
                    <div style=${{ minWidth: 0 }}><div class="fn">${r.fileName}</div><div class="fm">${r.f.name}</div></div>
                  </button>
                  <span class="val">${r.words}</span>
                  <span class="val">${r.updatedLabel}</span>
                  <div class="act">
                    <button type="button" class="ms more-btn" aria-label="Aktionen" aria-haspopup="true" aria-expanded=${open} onClick=${e => { stop(e); this.setState({ menuId: open ? null : d.id, filterOpen: false }); }}>more_vert</button>
                    ${open && html`
                      <div class="menu row-menu" onClick=${stop}>
                        <button type="button" class="menu-item" onClick=${() => this.go('doc', { docId: d.id })}><span class="ms">visibility</span>Öffnen</button>
                        ${canEdit && html`<button type="button" class="menu-item" onClick=${() => this.openEditor(d)}><span class="ms">edit</span>Bearbeiten</button>`}
                        <button type="button" class="menu-item" onClick=${() => { this.setState({ menuId: null }); this.toggleBookmark(d); }}><span class="ms">bookmark</span>${d.bookmarked ? 'Lesezeichen entfernen' : 'Lesezeichen setzen'}</button>
                        <button type="button" class="menu-item" onClick=${() => { this.setState({ menuId: null }); download(fileName(d), docMd(d)); }}><span class="ms">download</span>Als .md herunterladen</button>
                        ${canEdit && html`<div class="menu-sep"></div><button type="button" class="menu-item danger" onClick=${() => this.removeDoc(d)}><span class="ms">delete</span>Löschen</button>`}
                      </div>`}
                  </div>
                </div>`;
            })}
            ${listed.length === 0 && html`<div class="table-empty"><div class="t">Keine Dokumente gefunden</div><div class="s">Suche oder Filter anpassen${canEdit ? ' – oder ein neues Dokument anlegen' : ''}.</div></div>`}
          </div>
        </div>
      </div>`;
  }

  // ---------- Dokumentansicht ----------
  renderDoc() {
    const s = this.state;
    const d = this.doc(s.docId);
    if (!d) {
      return html`<div class="page g18"><div class="card empty-big"><div class="t">Dokument nicht gefunden</div><div class="s">Es wurde gelöscht oder du hast einen ungültigen Link geöffnet.</div>
        <div style=${{ marginTop: '14px' }}><button type="button" class="btn btn-ghost md" onClick=${() => this.go('docs', { folder: null, tag: null, q: '' })}>Zu den Dokumenten</button></div></div></div>`;
    }
    const canEdit = this.canEdit();
    const f = this.F(d.folder), c = fcol(f.hue);
    const r = md(d.content, { interactive: canEdit });
    const openFolder = () => this.go('docs', { folder: d.folder, tag: null, q: '' });
    return html`
      <div class="page g18" data-screen-label="Dokument">
        <div class="row-between">
          <div class="crumbs">
            <button type="button" class="c" onClick=${() => this.go('docs', { folder: null, tag: null, q: '' })}>Dokumente</button><span class="ms">chevron_right</span>
            <button type="button" class="c" onClick=${openFolder}>${f.name}</button><span class="ms">chevron_right</span>
            <span class="cur">${d.title}</span>
          </div>
          ${this.headIcons()}
        </div>
        <div class="doc-head">
          <div class="left">
            <h1 class="doc-title">${d.title}</h1>
            <div class="doc-meta">
              <button type="button" class="folder-chip" style=${{ background: c.background }} onClick=${openFolder}><span class="ms" style=${{ color: c.color }}>${f.icon}</span>${f.name}</button>
              ${d.tags.map(t => html`<button type="button" class="tag-chip" onClick=${() => this.go('docs', { folder: null, tag: t, q: '' })}>#${t}</button>`)}
              <span class="small muted" style=${{ marginLeft: '5px', fontSize: '12px' }}>Geändert ${fmtDate(d.updated)}${d.updatedBy ? ` von ${d.updatedBy}` : ''} · ${fmtWords(wordsOf(d.content))}</span>
            </div>
          </div>
          <div class="doc-actions">
            ${canEdit && html`<button type="button" class="sq-btn" title=${d.pinned ? 'Nicht mehr anpinnen' : 'Anpinnen'} aria-pressed=${d.pinned} onClick=${() => this.togglePin(d)}><span class=${'ms' + (d.pinned ? ' fill' : '')}>keep</span></button>`}
            <button type="button" class="sq-btn" title=${d.bookmarked ? 'Lesezeichen entfernen' : 'Lesezeichen setzen'} aria-pressed=${d.bookmarked} onClick=${() => this.toggleBookmark(d)}><span class=${'ms' + (d.bookmarked ? ' fill' : '')}>bookmark</span></button>
            <button type="button" class="sq-btn" title="Versionsverlauf" onClick=${() => this.openRevisions(d)}><span class="ms">history</span></button>
            <button type="button" class="sq-btn" title="Als .md herunterladen" onClick=${() => download(fileName(d), docMd(d))}><span class="ms">download</span></button>
            ${canEdit && html`<button type="button" class="sq-btn" title="Löschen" onClick=${() => { if (confirm(`„${d.title}“ in den Papierkorb verschieben?`)) this.removeDoc(d); }}><span class="ms">delete</span></button>`}
            ${canEdit && html`<button type="button" class="btn btn-primary edit" onClick=${() => this.openEditor(d)}><span class="ms">edit</span>Bearbeiten</button>`}
          </div>
        </div>
        <div class="doc-body">
          <article class="article">
            <div class="md-body" onClick=${e => this.onArticleClick(e, d)} onKeyDown=${e => this.onArticleKey(e, d)} dangerouslySetInnerHTML=${{ __html: r.html }}></div>
          </article>
          ${r.toc.length > 1 && html`
            <aside class="toc">
              <div class="toc-label">AUF DIESER SEITE</div>
              ${r.toc.map(h => html`<button type="button" class=${'toc-item' + (h.level === 3 ? ' l3' : '')} onClick=${() => this.scrollToEl(document.getElementById(h.id))}>${h.text}</button>`)}
            </aside>`}
        </div>
      </div>`;
  }

  // ---------- Editor ----------
  renderEditor(st) {
    const s = this.state, dr = s.draft;
    const showPreview = st.livePreview;
    const tools = [
      ['title', 'Überschrift', () => this.insert('## ', '', '', true)],
      ['format_bold', 'Fett', () => this.insert('**', '**', 'fett')],
      ['format_italic', 'Kursiv', () => this.insert('*', '*', 'kursiv')],
      ['code', 'Inline-Code', () => this.insert('`', '`', 'code')],
      ['data_object', 'Code-Block', () => this.insert('\n```bash\n', '\n```\n', 'befehl')],
      ['format_list_bulleted', 'Liste', () => this.insert('- ', '', '', true)],
      ['format_list_numbered', 'Nummerierte Liste', () => this.insert('1. ', '', '', true)],
      ['checklist', 'Aufgabe', () => this.insert('- [ ] ', '', '', true)],
      ['link', 'Link', () => this.insert('[', '](https://)', 'Linktext')],
      ['table', 'Tabelle', () => this.insert('\n| Host | IP | Rolle |\n|---|---|---|\n| ', ' | 10.0.20.x | |\n', 'name')],
      ['format_quote', 'Hinweis', () => this.insert('> ', '', '', true)],
      ['horizontal_rule', 'Trennlinie', () => this.insert('\n---\n', '', '')],
    ];
    const cancel = () => (dr.id ? this.go('doc', { docId: dr.id }) : this.go(s.folder ? 'docs' : 'dashboard'));
    return html`
      <div class="page g15" data-screen-label="Editor">
        <div class="crumbs">
          <button type="button" class="c" style=${{ display: 'flex', alignItems: 'center', gap: '4px' }} onClick=${cancel}><span class="ms">arrow_back</span>Zurück</button>
          <span style=${{ margin: '0 5px', color: '#d1d5db' }}>|</span>
          <span>${dr.id ? 'Dokument bearbeiten' : 'Neues Dokument'}</span>
          ${this.isDirty() && html`<span class="pill warn" style=${{ marginLeft: '8px' }}>Ungespeichert</span>`}
        </div>
        <div class="toolbar">
          <input class="title-input" value=${dr.title} onInput=${e => this.setDraft({ title: e.target.value })} placeholder="Titel des Dokuments" maxlength="200" aria-label="Titel" />
          <button type="button" class="btn btn-ghost cancel" onClick=${cancel}>Abbrechen</button>
          <button type="button" class="btn btn-primary save" disabled=${s.saving} onClick=${() => this.save()}><span class="ms s16">check</span>${s.saving ? 'Speichert …' : 'Speichern'}</button>
        </div>
        <div style=${{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          <label class="field-chip"><span class="ms">folder</span>
            <select value=${dr.folder} onChange=${e => this.setDraft({ folder: e.target.value })} aria-label="Ordner">
              ${s.folders.map(f => html`<option value=${f.id}>${f.name}</option>`)}
            </select>
          </label>
          <label class="field-chip tags"><span class="ms">sell</span>
            <input value=${dr.tags} onInput=${e => this.setDraft({ tags: e.target.value })} placeholder="Tags, kommagetrennt" aria-label="Tags" />
          </label>
        </div>
        <div class="editor-card">
          <div class="editor-tools">
            ${tools.map(([icon, label, run]) => html`<button type="button" class="ms tool" title=${label} aria-label=${label} onClick=${run}>${icon}</button>`)}
            <div class="spacer"></div>
            <span style=${{ fontSize: '11.5px', color: 'var(--muted)', marginRight: '11px' }}>${fmtWords(wordsOf(dr.content))}</span>
            <button type="button" class="toggle-wrap" role="switch" aria-checked=${showPreview} onClick=${() => this.setSettings({ livePreview: !showPreview })}>Vorschau<${Toggle} on=${showPreview} /></button>
          </div>
          <div class=${'editor-grid' + (showPreview ? ' split' : '')}>
            <textarea class="editor-ta" ref=${this.taRef} value=${dr.content} spellcheck="false" aria-label="Inhalt (Markdown)"
              style=${{ fontSize: (st.fontSize || 14) + 'px', whiteSpace: st.wrap ? 'pre-wrap' : 'pre' }}
              placeholder=${'## Überschrift\n\nSchreibe hier in Markdown …'}
              onInput=${e => this.setDraft({ content: e.target.value })}
              onKeyDown=${e => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); this.save(); }
                else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); this.insert('  ', '', ''); }
              }}></textarea>
            ${showPreview && html`<div class="editor-preview"><div class="md-body" dangerouslySetInnerHTML=${{ __html: md(dr.content).html }}></div></div>`}
          </div>
        </div>
        <div class="hint">Tipp: <span class="mono">Strg/⌘ + S</span> speichert.</div>
      </div>`;
  }

  // ---------- Suche ----------
  renderSearch() {
    const s = this.state;
    const sq = s.sq.trim().toLowerCase();
    const results = [];
    if (sq) s.docs.forEach(d => {
      const clean = plain(d.content).replace(/[#|>]/g, ' ').replace(/\s+/g, ' ').trim();
      const idx = clean.toLowerCase().indexOf(sq), inTitle = d.title.toLowerCase().includes(sq), inTag = d.tags.some(t => t.includes(sq));
      if (idx < 0 && !inTitle && !inTag) return;
      const r = this.row(d);
      if (idx >= 0) { r.pre = (idx > 70 ? '…' : '') + clean.slice(Math.max(0, idx - 70), idx); r.match = clean.slice(idx, idx + sq.length); r.post = clean.slice(idx + sq.length, idx + sq.length + 120) + '…'; }
      else { r.pre = r.excerpt; r.match = ''; r.post = ''; }
      r.score = (inTitle ? 2 : 0) + (idx >= 0 ? 1 : 0);
      results.push(r);
    });
    results.sort((a, b) => b.score - a.score || b.d.updated - a.d.updated);
    const tagCounts = {};
    s.docs.forEach(d => d.tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
    const tagNames = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a] || a.localeCompare(b));
    return html`
      <div class="page g20" data-screen-label="Suche">
        <div class="page-head"><h1 class="h1">Suche</h1>${this.headIcons()}</div>
        ${this.globalSearchInput('search-box big', 'Titel, Inhalte, IP-Adressen, Befehle …')}
        ${sq ? html`
          <div style=${{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style=${{ fontSize: '13px', color: 'var(--muted)' }}>${results.length} Treffer</div>
            ${results.map(r => html`
              <button type="button" class="card click result" onClick=${() => this.go('doc', { docId: r.d.id })}>
                <div class="ficon s32" style=${r.c}><span class="ms">description</span></div>
                <div style=${{ minWidth: 0, flex: 1 }}>
                  <div class="t">${r.d.title}</div>
                  <div class="m">${r.f.name} • ${r.updatedLabel}</div>
                  <p>${r.pre}${r.match && html`<mark>${r.match}</mark>`}${r.post}</p>
                </div>
              </button>`)}
            ${results.length === 0 && html`<div class="box-empty">Keine Treffer für „${s.sq}“.</div>`}
          </div>` : html`
          <div style=${{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <h2 class="h2 s16">Nach Tags stöbern</h2>
            <div class="tags-wrap">
              ${tagNames.map(t => html`<button type="button" class="tag-chip lg" onClick=${() => this.go('docs', { folder: null, tag: t, q: '' })}>#${t}<span class="faint">${tagCounts[t]}</span></button>`)}
              ${tagNames.length === 0 && html`<span class="small muted">Noch keine Tags vorhanden.</span>`}
            </div>
          </div>`}
      </div>`;
  }

  // ---------- Benachrichtigungen ----------
  renderNotifications(staleDocs, touched) {
    const s = this.state, now = Date.now();
    return html`
      <div class="page g20 narrow" data-screen-label="Benachrichtigungen">
        <div><h1 class="h1">Benachrichtigungen</h1><p class="sub">Dokumente, die seit über ${s.meta.staleDays} Tagen nicht aktualisiert wurden.</p></div>
        <div class="card list">
          ${staleDocs.map(d => html`
            <div class="notif-row">
              <div class="ficon s32 notif-icon"><span class="ms">schedule</span></div>
              <div style=${{ flex: '1 1 260px', minWidth: 0 }}>
                <div class="t">${d.title}</div>
                <div class="m">${this.F(d.folder).name} • seit ${Math.floor((now - touched(d)) / DAY)} Tagen unverändert</div>
              </div>
              <button type="button" class="btn btn-ghost sm" onClick=${() => this.go('doc', { docId: d.id })}>Öffnen</button>
              ${this.canEdit() && html`<button type="button" class="btn btn-primary sm" onClick=${() => this.review(d)}>Als geprüft markieren</button>`}
            </div>`)}
          ${staleDocs.length === 0 && html`<div class="empty-big"><div class="t">Alles aktuell</div><div class="s">Keine Dokumente warten auf Überprüfung.</div></div>`}
        </div>
      </div>`;
  }

  // ---------- Modals ----------
  renderHelp() {
    return html`
      <div class="overlay" onClick=${() => this.setState({ helpOpen: false })}>
        <div class="modal" role="dialog" aria-modal="true" aria-label="Markdown-Spickzettel" onClick=${stop}>
          <div class="modal-head"><h2 class="h2">Markdown-Spickzettel</h2><button type="button" class="ms close-btn" aria-label="Schließen" onClick=${() => this.setState({ helpOpen: false })}>close</button></div>
          ${CHEATS.map(c => html`<div class="cheat"><code>${c.syntax}</code><span>${c.label}</span></div>`)}
        </div>
      </div>`;
  }
  renderRevisions() {
    const s = this.state, d = this.doc(s.rev.docId);
    if (!d) return null;
    const current = { id: null, version: d.version, title: d.title, content: d.content, created: d.updated, author: d.updatedBy };
    const list = [current].concat(s.rev.list);
    const sel = list.find(x => x.id === s.rev.sel) || current;
    const close = () => this.setState({ rev: null });
    return html`
      <div class="overlay" onClick=${close}>
        <div class="modal wide" role="dialog" aria-modal="true" aria-label="Versionsverlauf" onClick=${stop}>
          <div class="modal-head"><h2 class="h2">Versionsverlauf – ${d.title}</h2><button type="button" class="ms close-btn" aria-label="Schließen" onClick=${close}>close</button></div>
          <div class="rev-grid">
            <div class="rev-list">
              ${list.map(x => html`
                <button type="button" class=${'rev-item' + (x === sel ? ' on' : '')} onClick=${() => this.setState({ rev: { ...s.rev, sel: x.id } })}>
                  <div class="t">Version ${x.version}${x.id === null ? ' (aktuell)' : ''}</div>
                  <div class="m">${fmtDate(x.created)}${x.author ? ' · ' + x.author : ''}</div>
                </button>`)}
            </div>
            <div class="rev-preview">
              <div class="row-between" style=${{ marginBottom: '12px' }}>
                <div style=${{ fontWeight: 600 }}>${sel.title}</div>
                ${sel.id !== null && this.canEdit() && html`<button type="button" class="btn btn-primary sm" onClick=${() => this.restoreRevision(d, sel)}><span class="ms s16">restore</span>Diese Version wiederherstellen</button>`}
              </div>
              <div class="md-body" dangerouslySetInnerHTML=${{ __html: md(sel.content).html }}></div>
            </div>
          </div>
        </div>
      </div>`;
  }
}

render(html`<${App} />`, document.getElementById('app'));
