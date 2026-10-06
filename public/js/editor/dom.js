// Hilfsfunktionen für contenteditable-Blöcke: DOM ⇄ Markdown, Cursor-Positionen.
import { inline } from '../md.js';

// Text → Markdown escapen (nur was sonst als Formatierung gelesen würde)
export function escText(t) {
  let s = String(t).replace(/ /g, ' ');
  s = s.replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\');
  s = s.replace(/([*`])/g, '\\$1');
  s = s.replace(/~~/g, '\\~\\~');
  s = s.replace(/\{\{/g, '\\{{');
  s = s.replace(/\[(?=[^\]]*\]\(|\^)/g, '\\[');
  s = s.replace(/!(?=\\\[)/g, '\\!');
  if ((s.match(/\$/g) || []).length >= 2) s = s.replace(/\$/g, '\\$');
  return s;
}

function wrapMd(mark, inner) {
  if (!inner.trim()) return inner;
  // Leerzeichen an den Rändern aus der Markierung herausziehen
  const lead = inner.match(/^\s*/)[0], trail = inner.match(/\s*$/)[0];
  return lead + mark + inner.trim() + mark + trail;
}

export function nodeToMd(node) {
  if (node.nodeType === 3) return escText(node.data);
  if (node.nodeType !== 1) return '';
  const el = node;
  if (el.dataset && el.dataset.md !== undefined) return el.dataset.md;
  const tag = el.tagName;
  if (tag === 'BR') return '\n';
  const inner = () => Array.from(el.childNodes).map(nodeToMd).join('');
  switch (tag) {
    case 'B': case 'STRONG': return wrapMd('**', inner());
    case 'I': case 'EM': return wrapMd('*', inner());
    case 'S': case 'DEL': case 'STRIKE': return wrapMd('~~', inner());
    case 'CODE': {
      const t = el.textContent.replace(/ /g, ' ');
      if (!t) return '';
      const ticks = Math.max(0, ...(t.match(/`+/g) || []).map(x => x.length)) + 1;
      const f = '`'.repeat(ticks);
      return f + (t.startsWith('`') || t.endsWith('`') ? ' ' + t + ' ' : t) + f;
    }
    case 'A': {
      const href = el.getAttribute('href') || '';
      const text = inner();
      return href && text ? `[${text}](${href.replace(/[()\s]/g, c => encodeURIComponent(c))})` : text;
    }
    case 'DIV': case 'P': { const t = inner(); return t ? '\n' + t : ''; }
    default: return inner();
  }
}

export function domToMd(el) {
  let s = Array.from(el.childNodes).map(nodeToMd).join('');
  s = s.replace(/^\n+/, '').replace(/\n+$/, '');
  return s;
}

export const toEditHtml = text => inline(text, {}, 'edit');

// ---------- Cursor ----------
// Länge eines Knotens in "Zeichen": Atome (contenteditable=false) und <br> zählen als 1.
function nodeLen(n) {
  if (n.nodeType === 3) return n.data.length;
  if (n.nodeType !== 1 && n.nodeType !== 11) return 0;
  if (n.nodeType === 1 && (n.getAttribute('contenteditable') === 'false' || n.tagName === 'BR' || n.tagName === 'IMG')) return 1;
  let k = 0;
  for (const c of n.childNodes) k += nodeLen(c);
  return k;
}
export const textLen = el => nodeLen(el);

export function caretOffset(el) {
  const sel = getSelection();
  if (!sel.rangeCount) return 0;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return 0;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  const frag = pre.cloneContents();
  return nodeLen(frag);
}

export function setCaret(el, offset) {
  el.focus();
  const sel = getSelection();
  const r = document.createRange();
  let left = Math.max(0, offset);
  const walk = n => {
    for (const c of n.childNodes) {
      const isAtom = c.nodeType === 1 && (c.getAttribute('contenteditable') === 'false' || c.tagName === 'BR' || c.tagName === 'IMG');
      if (c.nodeType === 3) {
        if (left <= c.data.length) { r.setStart(c, left); return true; }
        left -= c.data.length;
      } else if (isAtom) {
        if (left === 0) { r.setStartBefore(c); return true; }
        left -= 1;
        if (left === 0) { r.setStartAfter(c); return true; }
      } else if (c.nodeType === 1 && walk(c)) return true;
    }
    return false;
  };
  if (!walk(el)) { r.selectNodeContents(el); r.collapse(false); }
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

export function caretAtStart(el) {
  const sel = getSelection();
  return sel.rangeCount && sel.isCollapsed && caretOffset(el) === 0;
}
export function caretAtEnd(el) {
  const sel = getSelection();
  return sel.rangeCount && sel.isCollapsed && caretOffset(el) >= textLen(el);
}

// Liegt der Cursor in der ersten/letzten Zeile des Elements?
function caretRect() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(true);
  let rect = r.getClientRects()[0];
  if (!rect) {
    const span = document.createElement('span');
    span.textContent = '​';
    r.insertNode(span);
    rect = span.getBoundingClientRect();
    span.remove();
  }
  return rect;
}
export function caretOnFirstLine(el) {
  if (!textLen(el)) return true;
  const rc = caretRect(), box = el.getBoundingClientRect();
  if (!rc) return true;
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
  return rc.top - box.top < lh * 0.9;
}
export function caretOnLastLine(el) {
  if (!textLen(el)) return true;
  const rc = caretRect(), box = el.getBoundingClientRect();
  if (!rc) return true;
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
  return box.bottom - rc.bottom < lh * 0.9;
}
export function caretClientRect() { return caretRect(); }

// Inhalt ab dem Cursor bis zum Ende ausschneiden und als Markdown zurückgeben
export function splitAtCaret(el) {
  const sel = getSelection();
  if (!sel.rangeCount) return '';
  const r = sel.getRangeAt(0);
  r.deleteContents();
  const tail = document.createRange();
  tail.setStart(r.startContainer, r.startOffset);
  tail.setEnd(el, el.childNodes.length);
  const frag = tail.extractContents();
  const box = document.createElement('div');
  box.appendChild(frag);
  return domToMd(box);
}
