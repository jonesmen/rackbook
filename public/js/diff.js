// Zeilenweiser Vergleich zweier Texte (längste gemeinsame Teilfolge).
// Ergebnis: [{ t: ' ' | '-' | '+', s: Zeile }] – „-“ nur in a, „+“ nur in b.
export function lineDiff(a, b) {
  const A = String(a ?? '').split('\n'), B = String(b ?? '').split('\n');
  // Gemeinsamen Anfang und Schluss abtrennen (hält die Tabelle klein)
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length, endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB--; }
  const x = A.slice(start, endA), y = B.slice(start, endB);
  const out = A.slice(0, start).map(s => ({ t: ' ', s }));
  if (x.length * y.length > 4e6) {
    // Zu groß für den genauen Vergleich: Block als ersetzt darstellen
    x.forEach(s => out.push({ t: '-', s }));
    y.forEach(s => out.push({ t: '+', s }));
  } else {
    const n = x.length, m = y.length, w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { out.push({ t: ' ', s: x[i] }); i++; j++; }
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({ t: '-', s: x[i++] });
      else out.push({ t: '+', s: y[j++] });
    }
    while (i < n) out.push({ t: '-', s: x[i++] });
    while (j < m) out.push({ t: '+', s: y[j++] });
  }
  A.slice(endA).forEach(s => out.push({ t: ' ', s }));
  return out;
}

// Nur geänderte Stellen mit etwas Umgebung (für die Anzeige); Lücken als { t: '…' }
export function diffHunks(rows, context = 2) {
  const keep = new Uint8Array(rows.length);
  rows.forEach((r, k) => { if (r.t !== ' ') for (let d = -context; d <= context; d++) if (rows[k + d]) keep[k + d] = 1; });
  const out = [];
  rows.forEach((r, k) => {
    if (keep[k]) out.push(r);
    else if (!out.length || out[out.length - 1].t !== '…') out.push({ t: '…', s: '' });
  });
  return out;
}
