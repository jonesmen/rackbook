// Excalidraw-Editor für Rackbook (läuft in /excalidraw.html im iframe, Kommunikation per postMessage)
import './excalidraw-assets.js';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, exportToSvg, loadFromBlob, MainMenu } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

const parentOrigin = location.origin;
const send = msg => window.parent.postMessage(msg, parentOrigin);

function App() {
  const apiRef = useRef(null);
  const [initial, setInitial] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const loaded = useRef(false);
  const sigRef = useRef(null);

  useEffect(() => {
    const onMsg = async e => {
      if (e.origin !== parentOrigin || e.source !== window.parent) return;
      const m = e.data || {};
      if (m.type === 'load') {
        let data = { elements: [], appState: {}, files: {} };
        if (m.svg) {
          try { data = await loadFromBlob(new Blob([m.svg], { type: 'image/svg+xml' }), null, null); } catch (err) { console.warn(err); }
        }
        setInitial({ elements: data.elements || [], appState: { ...(data.appState || {}), collaborators: new Map() }, files: data.files || {}, scrollToContent: true });
        loaded.current = true;
      } else if (m.type === 'saved') { setBusy(false); setDirty(false); sigRef.current = null; }
    };
    window.addEventListener('message', onMsg);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const save = async exit => {
    const api = apiRef.current;
    if (!api) return;
    setBusy(true);
    const svg = await exportToSvg({
      elements: api.getSceneElements(),
      appState: { ...api.getAppState(), exportEmbedScene: true, exportBackground: true, viewBackgroundColor: '#ffffff' },
      files: api.getFiles(),
      exportPadding: 16,
    });
    send({ type: 'save', svg: new XMLSerializer().serializeToString(svg), exit });
    if (exit) setBusy(false);
  };

  if (!initial) return <div className="rb-loading">Excalidraw wird geladen …</div>;
  return (
    <div className="rb-wrap">
      <div className="rb-bar">
        <span className="rb-state">{busy ? 'Speichert …' : dirty ? 'Ungespeicherte Änderungen' : 'Gespeichert'}</span>
        <button type="button" disabled={busy} onClick={() => save(false)}>Speichern</button>
        <button type="button" className="primary" disabled={busy} onClick={() => save(true)}>Speichern &amp; schließen</button>
        <button type="button" onClick={() => { if (!dirty || confirm('Änderungen verwerfen?')) send({ type: 'exit' }); }}>Abbrechen</button>
      </div>
      <div className="rb-canvas">
        <Excalidraw excalidrawAPI={api => { apiRef.current = api; }} initialData={initial} langCode="de-DE"
          onChange={elements => {
            // Nur echte Änderungen zählen (Excalidraw meldet auch beim Laden/Auswählen Änderungen)
            const sig = elements.map(e => e.id + ':' + e.version).join('|');
            if (sigRef.current === null) sigRef.current = sig;
            else if (sig !== sigRef.current) setDirty(true);
          }}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: { saveFileToDisk: true }, toggleTheme: true } }}>
          <MainMenu>
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
