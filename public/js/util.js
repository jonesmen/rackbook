import { html, Component } from '/vendor/preact-htm.js';

// Dialog-Hintergrund: schließt bei Klick daneben (nicht beim Loslassen einer Textmarkierung) und mit Esc,
// hält den Tastaturfokus im Dialog und gibt ihn danach zurück.
export class Overlay extends Component {
  ref = { current: null };
  componentDidMount() {
    this.prev = document.activeElement;
    const el = this.ref.current;
    const f = el && (el.querySelector('[autofocus]') || el.querySelector('input:not([type=hidden]):not([type=file]), textarea, select') || el.querySelector('button:not(.close-btn)') || el.querySelector('button'));
    if (f) f.focus();
  }
  componentWillUnmount() { try { if (this.prev && this.prev.focus && document.contains(this.prev)) this.prev.focus(); } catch { /* egal */ } }
  onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); this.props.onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(this.ref.current.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]):not([type=file]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(x => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  render({ cls, children, onClose }) {
    return html`<div class=${'overlay ' + (cls || '')} ref=${this.ref} onMouseDown=${e => { if (e.target === e.currentTarget) onClose(); }} onKeyDown=${this.onKey}>${children}</div>`;
  }
}
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
export const MOD = IS_MAC ? '⌘' : 'Strg';
// Anzahl mit passender Form: plural(1, 'Dokument', 'Dokumente') → „1 Dokument“
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export const DAY = 86400000;
export const ACCENTS = {
  mint: { soft: 'oklch(0.9 0.09 162)', strong: 'oklch(0.6 0.14 162)' },
  blau: { soft: 'oklch(0.9 0.06 250)', strong: 'oklch(0.56 0.16 250)' },
  violett: { soft: 'oklch(0.9 0.07 295)', strong: 'oklch(0.55 0.18 295)' },
};
export const DEFAULT_SETTINGS = { openMode: 'read', wrap: true, fontSize: 14, theme: 'system', accent: 'mint', startPage: 'dashboard', sidebarCollapsed: false, bmOpen: true };
export const ROLE_LABEL = { admin: 'Administrator', editor: 'Bearbeiter', viewer: 'Leser' };
export const STATUS_LABEL = { active: 'Aktiv', pending: 'Wartet auf Freischaltung', disabled: 'Deaktiviert' };

// Helles/dunkles Design: 'system' folgt dem Betriebssystem. Die Wahl wird lokal gemerkt, damit auch
// Anmelde- und Ladebildschirm passen.
export const isDark = () => document.documentElement.dataset.theme === 'dark';
let themePref = 'system';
const systemDark = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
export function applyTheme(pref) {
  if (pref === undefined) { try { pref = localStorage.getItem('rackbook.theme') || 'system'; } catch { pref = 'system'; } }
  else if (pref !== themePref) { try { localStorage.setItem('rackbook.theme', pref); } catch { /* egal */ } }
  themePref = ['light', 'dark'].includes(pref) ? pref : 'system';
  const dark = themePref === 'dark' || (themePref === 'system' && systemDark && systemDark.matches);
  if (dark) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme;
  return dark;
}
if (systemDark) systemDark.addEventListener('change', () => { if (themePref === 'system') { applyTheme('system'); window.dispatchEvent(new Event('rackbook-theme')); } });

export const fcol = h => (isDark() ? { background: `oklch(0.32 0.05 ${h})`, color: `oklch(0.82 0.11 ${h})` } : { background: `oklch(0.955 0.035 ${h})`, color: `oklch(0.62 0.16 ${h})` });
export const wordsOf = c => (c || '').split(/\s+/).filter(Boolean).length;
export const fmtWords = n => n.toLocaleString('de-DE') + ' Wörter';

// Im Satz: „geändert heute, 14:30“ statt „geändert Heute, 14:30“
export const fmtDateIn = ts => fmtDate(ts).replace(/^(Heute|Gestern)/, m => m.toLowerCase());
export function fmtDate(ts) {
  if (!ts) return '–';
  const d = new Date(ts), now = new Date();
  const t = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const sd = (a, b) => a.toDateString() === b.toDateString();
  if (sd(d, now)) return 'Heute, ' + t;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (sd(d, y)) return 'Gestern, ' + t;
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
}
export const fmtDateTime = ts => (ts ? new Date(ts).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');

export function download(name, text, type = 'text/markdown') {
  const b = new Blob([text], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
export const fileName = d => d.title.replace(/[\/\\:*?"<>|]/g, '-') + '.md';
export const docMd = d => `# ${d.title}\n\n${d.content}\n`;
export const initials = name => (name || '?').split(/\s+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase();

export function describeUA(ua) {
  const s = ua || '';
  const b = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /curl/i.test(s) ? 'curl' : 'Browser';
  const o = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Mac OS/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return o ? `${b} auf ${o}` : b;
}

// Kleine UI-Bausteine
export const Icon = ({ name, cls = '', fill = false, title }) => html`<span class=${`ms ${cls}${fill ? ' fill' : ''}`} aria-hidden=${title ? undefined : 'true'} title=${title}>${name}</span>`;
export const Toggle = ({ on }) => html`<div class=${'toggle' + (on ? ' on' : '')} aria-hidden="true"><div></div></div>`;
export const stop = e => e && e.stopPropagation && e.stopPropagation();

// Text in die Zwischenablage (mit Ausweichlösung ohne HTTPS)
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) { try { await navigator.clipboard.writeText(text); return true; } catch { /* Ausweichlösung */ } }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}
