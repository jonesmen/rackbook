import { createApp, initDatabase, housekeeping } from './app.js';
import { config } from './config.js';
import { db } from './db.js';
import { scheduledBackup } from './backup.js';

initDatabase();
// Aufräumarbeiten dürfen den Server nicht beenden, wenn sie einmal scheitern
const tidy = () => {
  try { housekeeping(); } catch (e) { console.error('Aufräumarbeiten fehlgeschlagen:', e); }
  // Automatische Sicherung nach Zeitplan (Verwaltung → Sicherungen)
  scheduledBackup().then(s => { if (s) console.log(`Automatische Sicherung erstellt: ${s.name}`); }).catch(e => console.error('Automatische Sicherung fehlgeschlagen:', e));
};
tidy();
const timer = setInterval(tidy, 60 * 60 * 1000);
timer.unref();

const server = createApp().listen(config.port, config.host, () => {
  console.log(`${config.appName} läuft auf http://${config.host}:${config.port} (Daten: ${config.dataDir})`);
});
server.headersTimeout = 30000;
// Großzügig, damit große Uploads und Sicherungen auch über langsame Leitungen durchgehen
server.requestTimeout = 30 * 60000;

// Unerwartete Fehler protokollieren. Nach einer nicht abgefangenen Ausnahme ist der Zustand unklar →
// sauber beenden, Docker startet den Container neu.
process.on('unhandledRejection', e => console.error('Unbehandelter Fehler (Promise):', e));
process.on('uncaughtException', e => { console.error('Nicht abgefangene Ausnahme:', e); shutdown('Fehler', 1); });

function shutdown(sig, code = 0) {
  console.log(`${sig} empfangen – fahre herunter …`);
  server.close(() => {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    process.exit(code);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
