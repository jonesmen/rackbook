import { createApp, initDatabase, housekeeping } from './app.js';
import { config } from './config.js';
import { db } from './db.js';

initDatabase();
housekeeping();
const timer = setInterval(housekeeping, 60 * 60 * 1000);
timer.unref();

const server = createApp().listen(config.port, config.host, () => {
  console.log(`${config.appName} läuft auf http://${config.host}:${config.port} (Daten: ${config.dataDir})`);
});
server.headersTimeout = 30000;
server.requestTimeout = 60000;

function shutdown(sig) {
  console.log(`${sig} empfangen – fahre herunter …`);
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
