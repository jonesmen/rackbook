// Kleiner, sicherer Markdown-Renderer. Gesamter Text wird escaped; Links werden auf
// sichere Schemata beschränkt. Ausgabe nutzt ausschließlich CSS-Klassen (CSP: keine Inline-Styles).

export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export const slug = s => s.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-|-$/g, '');

function safeHref(url) {
  const u = String(url).trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^(#|\/(?!\/)|\.\.?\/)/.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // javascript:, data:, vbscript: …
  return u;
}

function inl(s) {
  return s.split(/(`[^`]+`)/g).map(p => {
    if (/^`[^`]+`$/.test(p)) return `<code class="md-code">${esc(p.slice(1, -1))}</code>`;
    let t = esc(p);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
      // href ist bereits HTML-escaped; für die Schema-Prüfung zurückwandeln.
      const raw = href.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const ok = safeHref(raw);
      if (!ok) return text;
      const ext = /^(https?:|mailto:)/i.test(ok);
      return `<a href="${esc(ok)}"${ext ? ' target="_blank" rel="noopener noreferrer nofollow"' : ''}>${text}</a>`;
    });
    return t;
  }).join('');
}

export const plain = s => String(s || '').replace(/`/g, '').replace(/\*\*?/g, '').replace(/~~/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

export function md(src, { interactive = false } = {}) {
  const L = String(src || '').replace(/\r/g, '').split('\n');
  const out = [], toc = [], ids = {};
  const isTask = l => /^\s*[-*+]\s+\[[ xX]\]\s+/.test(l);
  const isUl = l => /^\s*[-*+]\s+/.test(l);
  const isOl = l => /^\s*\d+[.)]\s+/.test(l);
  const isStart = l => /^(#{1,4}\s|```|~~~|>|\|)/.test(l.trim()) || isUl(l) || isOl(l) || /^\s*(---|\*\*\*)\s*$/.test(l);
  let i = 0, m;
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    if ((m = l.match(/^\s*(```|~~~)\s*([\w+#.-]*)/))) {
      const f = m[1], lang = m[2], buf = []; i++;
      while (i < L.length && !L[i].trim().startsWith(f)) { buf.push(L[i]); i++; }
      i++;
      out.push(`<div class="md-pre-wrap">${lang ? `<span class="md-lang">${esc(lang)}</span>` : ''}<button type="button" class="md-copy ms" title="Kopieren" data-copy>content_copy</button><pre class="md-pre">${esc(buf.join('\n'))}</pre></div>`);
      continue;
    }
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) {
      const lv = m[1].length, t = m[2].trim();
      let id = 'h-' + (slug(plain(t)) || 'abschnitt');
      if (ids[id]) id += '-' + (++ids[id]); else ids[id] = 1;
      if (lv === 2 || lv === 3) toc.push({ id, text: plain(t), level: lv });
      out.push(`<h${lv} id="${id}" class="md-h${lv}">${inl(t)}</h${lv}>`);
      i++; continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(l)) { out.push('<hr class="md-hr">'); i++; continue; }
    if (l.trim().startsWith('|')) {
      const rows = [];
      while (i < L.length && L[i].trim().startsWith('|')) { rows.push(L[i].trim()); i++; }
      const cells = r => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(1).filter(r => !/^\|[\s:|-]+\|?$/.test(r)).map(cells);
      out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${head.map(h => `<th>${inl(h)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inl(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (l.trim().startsWith('>')) {
      const buf = [];
      while (i < L.length && L[i].trim().startsWith('>')) { buf.push(L[i].trim().replace(/^>\s?/, '')); i++; }
      out.push(`<div class="md-note"><span class="ms">info</span><div>${inl(buf.join(' '))}</div></div>`);
      continue;
    }
    if (isTask(l)) {
      const items = [];
      while (i < L.length && isTask(L[i])) {
        const mm = L[i].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
        items.push({ done: mm[1] !== ' ', t: mm[2], line: i }); i++;
      }
      out.push(`<ul class="md-tasks">${items.map(it => `<li class="${it.done ? 'done' : ''}"><span class="ms md-check${it.done ? ' fill' : ''}${interactive ? ' clickable' : ''}"${interactive ? ` data-task-line="${it.line}" role="checkbox" aria-checked="${it.done}" tabindex="0"` : ''}>${it.done ? 'check_box' : 'check_box_outline_blank'}</span><span>${inl(it.t)}</span></li>`).join('')}</ul>`);
      continue;
    }
    if (isUl(l) || isOl(l)) {
      const ord = isOl(l), items = [];
      while (i < L.length && (ord ? isOl(L[i]) : (isUl(L[i]) && !isTask(L[i])))) { items.push(L[i].replace(ord ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, '')); i++; }
      const tag = ord ? 'ol' : 'ul';
      out.push(`<${tag} class="md-list">${items.map(t => `<li>${inl(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const buf = [];
    while (i < L.length && L[i].trim() && !isStart(L[i])) { buf.push(L[i].trim()); i++; }
    if (!buf.length) { buf.push(l); i++; }
    out.push(`<p class="md-p">${inl(buf.join(' '))}</p>`);
  }
  if (!out.length) out.push('<p class="md-empty">Noch kein Inhalt.</p>');
  return { html: out.join(''), toc };
}

export function excerpt(c) {
  const line = String(c || '').split('\n').find(l => l.trim() && !/^(#|\||-|\*|>|```|~~~|\d+\.)/.test(l.trim())) || '';
  const t = plain(line);
  return t.length > 120 ? t.slice(0, 118) + '…' : t;
}
