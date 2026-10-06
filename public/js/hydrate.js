// Nachladen schwerer Bibliotheken (KaTeX, Mermaid) erst bei Bedarf und Anreichern gerenderter Inhalte.
const loading = {};
export function loadScript(src) {
  if (!loading[src]) {
    loading[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { delete loading[src]; reject(new Error('Laden fehlgeschlagen: ' + src)); };
      document.head.appendChild(s);
    });
  }
  return loading[src];
}

export async function renderTex(el, tex, display) {
  await loadScript('/vendor/katex/katex.min.js');
  try {
    // Nur MathML: braucht keine Inline-Styles (strenge CSP) und keine zusätzlichen Schriften.
    window.katex.render(String(tex), el, { output: 'mathml', displayMode: !!display, throwOnError: false, trust: false, strict: 'ignore', maxSize: 50, maxExpand: 500 });
    el.classList.add('rendered');
  } catch (e) {
    el.textContent = tex;
    el.classList.add('error');
  }
}

// Mermaid rendert in einem eigenen, unsichtbaren iframe (dort sind die von Mermaid benötigten
// Inline-Styles erlaubt, die strenge CSP der App bleibt unberührt). Das Ergebnis wird als Bild eingebettet.
let frame = null, frameReady = null, mermaidSeq = 0;
const pending = new Map();
function mermaidFrame() {
  if (frameReady) return frameReady;
  frameReady = new Promise((resolve, reject) => {
    frame = document.createElement('iframe');
    frame.src = '/mermaid-frame.html';
    frame.title = 'Mermaid-Renderer';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width: '1200px', height: '800px', border: '0', visibility: 'hidden' });
    const t = setTimeout(() => { frameReady = null; reject(new Error('Mermaid konnte nicht geladen werden.')); }, 20000);
    window.addEventListener('message', e => {
      if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin) return;
      const m = e.data || {};
      if (m.type === 'ready') { clearTimeout(t); resolve(); }
      if (m.type === 'rendered' && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error)); else p.resolve(m.svg); }
    });
    document.body.appendChild(frame);
  });
  return frameReady;
}
export async function mermaidSvg(src) {
  await mermaidFrame();
  const id = ++mermaidSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    frame.contentWindow.postMessage({ type: 'render', id, src: String(src) }, location.origin);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Zeitüberschreitung beim Rendern.')); } }, 15000);
  });
}
export function svgDataUrl(svg) {
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}
export async function renderMermaidInto(el, src) {
  try {
    const svg = await mermaidSvg(src);
    const img = document.createElement('img');
    img.className = 'md-mermaid-img';
    img.alt = 'Mermaid-Diagramm';
    // Natürliche Breite aus der viewBox übernehmen (sonst wird das Diagramm auf volle Breite gestreckt)
    const vb = svg.match(/viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/);
    if (vb) { img.width = Math.round(Number(vb[1])); img.height = Math.round(Number(vb[2])); }
    img.src = svgDataUrl(svg);
    el.replaceChildren(img);
    el.classList.add('rendered');
  } catch (e) {
    const box = document.createElement('div');
    box.className = 'md-render-error';
    box.textContent = 'Diagramm-Fehler: ' + String((e && e.message) || e).split('\n')[0].slice(0, 200);
    el.replaceChildren(box);
    el.classList.add('error');
  }
}

// Gerenderten Dokumentinhalt anreichern: Mathe, Mermaid, sortierbare Datenbanken.
export function hydrate(root) {
  if (!root) return;
  root.querySelectorAll('.md-math:not(.rendered):not(.error)').forEach(el => renderTex(el, el.dataset.tex, false));
  root.querySelectorAll('.md-math-block:not(.rendered):not(.error)').forEach(el => renderTex(el, el.dataset.tex, true));
  root.querySelectorAll('.md-mermaid:not(.rendered):not(.error)').forEach(el => renderMermaidInto(el, el.dataset.src));
}

// Klick auf Spaltenkopf einer Datenbank (Base) → sortieren
export function baseSortClick(e) {
  const th = e.target.closest && e.target.closest('th[data-sort-col]');
  if (!th) return false;
  const table = th.closest('table');
  const col = Number(th.dataset.sortCol);
  const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
  table.querySelectorAll('th[data-sort-col]').forEach(x => { delete x.dataset.dir; x.querySelector('.md-sort').textContent = 'unfold_more'; });
  th.dataset.dir = dir;
  th.querySelector('.md-sort').textContent = dir === 'asc' ? 'arrow_upward' : 'arrow_downward';
  const tbody = table.tBodies[0];
  const rows = Array.from(tbody.rows);
  const key = r => r.cells[col] ? r.cells[col].dataset.sort : '';
  const num = rows.every(r => key(r) === '' || !Number.isNaN(Number(key(r))));
  rows.sort((a, b) => {
    const x = key(a), y = key(b);
    const c = num ? (Number(x) || 0) - (Number(y) || 0) : x.localeCompare(y, 'de');
    return dir === 'asc' ? c : -c;
  });
  rows.forEach(r => tbody.appendChild(r));
  return true;
}
