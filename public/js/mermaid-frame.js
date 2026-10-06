// Unsichtbarer Mermaid-Renderer (eigenes iframe mit gelockerter Style-Richtlinie).
// Die App schickt den Diagramm-Quelltext und erhält das fertige SVG zurück.
window.mermaid.initialize({
  startOnLoad: false, securityLevel: 'strict', theme: 'neutral',
  fontFamily: 'Plus Jakarta Sans, system-ui, sans-serif',
  flowchart: { htmlLabels: false }, class: { htmlLabels: false }, state: { htmlLabels: false },
});
let seq = 0;
window.addEventListener('message', async e => {
  if (e.origin !== location.origin || e.source !== window.parent) return;
  const m = e.data || {};
  if (m.type !== 'render') return;
  const id = 'm' + (++seq);
  try {
    const { svg } = await window.mermaid.render(id, String(m.src || ''), document.getElementById('work'));
    window.parent.postMessage({ type: 'rendered', id: m.id, svg }, location.origin);
  } catch (err) {
    window.parent.postMessage({ type: 'rendered', id: m.id, error: String((err && err.message) || err).split('\n')[0].slice(0, 300) }, location.origin);
  } finally {
    document.getElementById(id)?.remove();
    document.getElementById('d' + id)?.remove();
  }
});
window.parent.postMessage({ type: 'ready' }, location.origin);
