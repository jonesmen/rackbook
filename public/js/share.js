// Öffentliche, nur lesende Ansicht einer Freigabe. Das Token steht im URL-Fragment (#token/dokument)
// und wird per POST an den Server geschickt – es erscheint nie in einer Server-URL.
import { html, render, useState, useEffect, useMemo } from '/vendor/preact-htm.js';
import { md } from './md.js';
import { hydrate, baseSortClick } from './hydrate.js';
import { fcol, fmtDate, fmtDateTime, Icon } from './util.js';

function parseHash() {
  const [token = '', doc = ''] = location.hash.replace(/^#/, '').split('/');
  return { token, doc: decodeURIComponent(doc) };
}
// Den Verlauf nicht mit Token-URLs füllen, aber Vor/Zurück innerhalb der Freigabe erlauben
const setDocInHash = (token, id, push) => history[push ? 'pushState' : 'replaceState'](null, '', `#${token}${id ? '/' + encodeURIComponent(id) : ''}`);

async function fetchShare(token, password) {
  const res = await fetch('/api/public/share', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(password ? { token, password } : { token }), credentials: 'omit', cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Interne Links: nur Dokumente dieser Freigabe bleiben anklickbar, alles andere wird zu Text.
function rewriteLinks(htmlStr, ids) {
  return htmlStr.replace(/<a ((?:class="[^"]*" )?)href="(\/[^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (m, cls, href, rest, text) => {
    if (href.startsWith('/files/')) return m; // signierte Datei-Links bleiben erhalten
    const d = href.match(/^\/doc\/([A-Za-z0-9_-]+)$/);
    if (d && ids.has(d[1])) return `<a ${cls}href="#" data-doc="${d[1]}">${text}</a>`;
    return `<span class="md-dead" title="Nicht Teil dieser Freigabe">${text}</span>`;
  });
}

// Gerenderter Inhalt mit Nachladen von Formeln/Diagrammen
function Content({ html: h, onClick }) {
  const ref = { current: null };
  useEffect(() => { hydrate(ref.current); }, [h]);
  return html`<div class="md-body" ref=${el => { ref.current = el; }} onClick=${e => { if (!baseSortClick(e)) onClick(e); }} dangerouslySetInnerHTML=${{ __html: h }}></div>`;
}

function Tree({ data, current, onOpen }) {
  const [open, setOpen] = useState({});
  const kids = id => data.docs.filter(d => d.parent === id).sort((a, b) => a.title.localeCompare(b.title, 'de'));
  const chain = useMemo(() => { const out = new Set(); let d = data.docs.find(x => x.id === current); while (d && d.parent) { out.add(d.parent); d = data.docs.find(x => x.id === d.parent); } return out; }, [current]);
  const isOpen = key => (open[key] !== undefined ? open[key] : true) || chain.has(key);
  const items = [];
  const docRows = (list, depth) => list.forEach(d => {
    const k = kids(d.id);
    items.push(html`<button type="button" key=${d.id} class=${'nav-item folder tree-doc' + (d.id === current ? ' active' : '')} style=${{ paddingLeft: (11 + depth * 14) + 'px' }} onClick=${() => onOpen(d.id)} title=${d.title}>
      <span class="ms">${k.length ? 'auto_stories' : 'description'}</span><span class="grow">${d.title}</span>
      ${k.length ? html`<span class="ms tree-chev" onClick=${e => { e.stopPropagation(); setOpen({ ...open, [d.id]: !isOpen(d.id) }); }}>${isOpen(d.id) ? 'expand_more' : 'chevron_right'}</span>` : html`<span class="tree-chev-space"></span>`}
    </button>`);
    if (k.length && isOpen(d.id)) docRows(k, depth + 1);
  });
  const topDocs = folder => data.docs.filter(d => !d.parent && (folder === undefined || d.folder === folder)).sort((a, b) => a.title.localeCompare(b.title, 'de'));
  if (data.kind === 'doc') docRows(topDocs(), 0);
  else {
    const ids = new Set(data.folders.map(f => f.id));
    const folderRows = (parent, depth) => data.folders.filter(f => (f.parent && ids.has(f.parent) ? f.parent : null) === parent).forEach(f => {
      items.push(html`<button type="button" key=${'f' + f.id} class="nav-item folder" style=${{ paddingLeft: (11 + depth * 14) + 'px' }} onClick=${() => setOpen({ ...open, ['f' + f.id]: !isOpen('f' + f.id) })}>
        <span class="ms" style=${{ color: fcol(f.hue).color }}>${f.icon}</span><span class="grow">${f.name}</span>
        <span class="ms tree-chev">${isOpen('f' + f.id) ? 'expand_more' : 'chevron_right'}</span></button>`);
      if (isOpen('f' + f.id)) { folderRows(f.id, depth + 1); docRows(topDocs(f.id), depth + 1); }
    });
    folderRows(null, 0);
  }
  return html`<div class="nav">${items}</div>`;
}

function Viewer({ token, data }) {
  const [current, setCurrent] = useState(() => {
    const h = parseHash().doc;
    if (h && data.docs.some(d => d.id === h)) return h;
    if (data.kind === 'doc') return data.root;
    const first = data.docs.filter(d => !d.parent).sort((a, b) => a.title.localeCompare(b.title, 'de'))[0];
    return first ? first.id : null;
  });
  const ids = useMemo(() => new Set(data.docs.map(d => d.id)), [data]);
  const open = (id, push = true) => { setCurrent(id); setDocInHash(token, id, push); window.scrollTo(0, 0); const m = document.querySelector('.main'); if (m) m.scrollTop = 0; };
  useEffect(() => {
    const onPop = () => { const h = parseHash().doc; if (h && ids.has(h)) setCurrent(h); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const d = data.docs.find(x => x.id === current);
  useEffect(() => { document.title = `${d ? d.title + ' – ' : ''}${data.title} (geteilt)`; }, [current]);
  const kidsOf = id => data.docs.filter(x => x.parent === id).sort((a, b) => a.title.localeCompare(b.title, 'de'));
  const r = d ? md(d.content, {
    fileUrl: id => (data.files && data.files[id]) || null, embeds: data.embeds !== false, synced: data.synced || {}, assets: data.assets || {}, assetLinks: false,
    subpages: kidsOf(d.id).map(k => ({ id: k.id, title: k.title })),
  }) : { html: '', toc: [] };
  const crumbs = [];
  for (let x = d; x && x.parent; x = data.docs.find(y => y.id === x.parent)) crumbs.unshift(data.docs.find(y => y.id === x.parent));
  const kids = d ? data.docs.filter(x => x.parent === d.id).sort((a, b) => a.title.localeCompare(b.title, 'de')) : [];
  const onClick = e => {
    const a = e.target.closest && e.target.closest('a[data-doc]');
    if (a) { e.preventDefault(); open(a.dataset.doc); return; }
    const c = e.target.closest && e.target.closest('[data-copy]');
    if (c && navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(c.parentElement.querySelector('pre').textContent);
  };
  const single = data.docs.length === 1;
  return html`
    <div class="shell">
      ${!single && html`
        <aside class="sidebar">
          <div class="sb-scroll">
            <div class="sb-head"><div class="brand"><div class="logo">R</div><span class="brand-name">${data.title}</span></div></div>
            <div class="nav-label">GETEILTE INHALTE</div>
            <${Tree} data=${data} current=${current} onOpen=${open} />
          </div>
        </aside>`}
      <main class="main">
        <div class="container">
          <div class="page g18">
            <div class="share-banner"><${Icon} name="public" cls="s16" />Öffentlich geteilt · nur lesend${data.expiresAt ? ` · gültig bis ${fmtDateTime(data.expiresAt)}` : ''}</div>
            ${!d ? html`<div class="card empty-big"><div class="t">Keine Dokumente</div><div class="s">Diese Freigabe enthält keine Dokumente.</div></div>` : html`
              ${crumbs.length > 0 && html`<div class="crumbs">${crumbs.map(c => html`<button type="button" class="c" onClick=${() => open(c.id)}>${c.title}</button><span class="ms">chevron_right</span>`)}<span class="cur">${d.title}</span></div>`}
              <div><h1 class="doc-title">${d.title}</h1>
                <div class="doc-meta" style=${{ marginTop: '10px' }}>${d.tags.map(t => html`<span class="tag-chip">#${t}</span>`)}<span class="small muted" style=${{ marginLeft: '5px', fontSize: '12px' }}>Stand ${fmtDate(d.updated)}</span></div></div>
              <div class="doc-body">
                <div class="doc-main">
                  <article class="article"><${Content} html=${rewriteLinks(r.html, ids)} onClick=${onClick} /></article>
                  ${kids.length > 0 && html`
                    <div class="section g14"><h2 class="h2 s16">Unterseiten (${kids.length})</h2>
                      <div class="card list">${kids.map(k => html`<button type="button" class="list-row" onClick=${() => open(k.id)}><div class="ficon s30" style=${fcol(162)}><span class="ms">description</span></div><div style=${{ flex: 1, minWidth: 0 }}><div class="t">${k.title}</div></div><div class="d">${fmtDate(k.updated)}</div></button>`)}</div>
                    </div>`}
                </div>
                ${r.toc.length > 1 && html`<aside class="toc"><div class="toc-label">AUF DIESER SEITE</div>
                  ${r.toc.map(h => html`<button type="button" class=${'toc-item l' + h.level} onClick=${() => { const el = document.getElementById(h.id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>${h.text}</button>`)}</aside>`}
              </div>`}
            <div class="hint" style=${{ textAlign: 'center', marginTop: '20px' }}>Bereitgestellt mit ${data.appName || 'Rackbook'}</div>
          </div>
        </div>
      </main>
    </div>`;
}

function App() {
  const [{ token }] = useState(parseHash);
  const [state, setState] = useState({ phase: 'loading' });
  const [pw, setPw] = useState('');
  const load = async password => {
    if (!token) return setState({ phase: 'error', msg: 'Der Link ist unvollständig.' });
    const { status, data } = await fetchShare(token, password).catch(() => ({ status: 0, data: { error: 'Server nicht erreichbar.' } }));
    if (status === 200) return setState({ phase: 'ok', data });
    if (data.passwordRequired) return setState({ phase: 'password', msg: password ? data.error : '' });
    setState({ phase: 'error', msg: data.error || 'Dieser Link ist ungültig, abgelaufen oder wurde widerrufen.' });
  };
  useEffect(() => { load(); }, []);
  if (state.phase === 'loading') return html`<div class="loading">Wird geladen …</div>`;
  if (state.phase === 'ok') return html`<${Viewer} token=${token} data=${state.data} />`;
  return html`
    <div class="auth-wrap">
      <form class="auth-card" onSubmit=${e => { e.preventDefault(); load(pw); }}>
        <div class="brand"><div class="logo">R</div><span class="brand-name">Geteilte Dokumentation</span></div>
        ${state.phase === 'password' ? html`
          <div><h1>Passwort erforderlich</h1><p style=${{ marginTop: '6px' }}>Diese Freigabe ist mit einem Passwort geschützt.</p></div>
          ${state.msg && html`<div class="notice err" role="alert"><${Icon} name="error" />${state.msg}</div>`}
          <label class="field"><span>Passwort</span><input class="input" type="password" value=${pw} onInput=${e => setPw(e.target.value)} autocomplete="off" autofocus required /></label>
          <button class="btn btn-primary">Öffnen</button>` : html`
          <div class="notice err" role="alert"><${Icon} name="link_off" />${state.msg}</div>`}
      </form>
    </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
