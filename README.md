# Rackbook

Selbstgehostete Markdown-Dokumentation für Homelab & IT-Infrastruktur – als ein einziges, gehärtetes Docker-Image mit Mehrbenutzerverwaltung.

## Funktionen

**Dokumentation**
- Dashboard mit angepinnten Dokumenten, zuletzt bearbeiteten Dokumenten und offenen To-dos (`- [ ]` aus allen Dokumenten, direkt abhakbar)
- Ordner (frei anlegbar, mit Icon und Farbe), Tags, Tag-Filter, persönliche Lesezeichen
- Markdown-Editor mit Toolbar, Live-Vorschau, Zeilenumbruch, Schriftgröße, `Strg/⌘ + S`
- Dokumentansicht mit Inhaltsverzeichnis, kopierbaren Code-Blöcken und abhakbaren Checklisten
- Globale Volltextsuche mit Trefferhervorhebung (Titel, Inhalt, Tags, IPs, Befehle)
- Benachrichtigungen für Dokumente, die länger nicht geprüft wurden („Als geprüft markieren“)
- Versionsverlauf pro Dokument mit Wiederherstellung, Papierkorb mit „Rückgängig“
- Erkennung gleichzeitiger Bearbeitung (kein stilles Überschreiben)
- Import von `.md`-Dateien, Export als Markdown oder JSON-Backup, Backup einspielen, Beispieldaten

**Benutzerverwaltung**
- Der **erste registrierte Benutzer wird Administrator** (Ersteinrichtung im Browser)
- Rollen: **Leser** (nur lesen), **Bearbeiter** (Dokumente & Ordner), **Administrator** (zusätzlich Benutzer & System)
- Benutzer anlegen, Rollen ändern, freischalten, deaktivieren, entsperren, Passwort zurücksetzen (mit Pflicht zur Änderung), 2FA zurücksetzen, Sitzungen beenden, löschen
- Optionale Selbstregistrierung mit Freischaltung durch einen Admin
- Audit-Log aller sicherheitsrelevanten Ereignisse

**Sicherheit**
- Passwörter mit **scrypt** (memory-hard) gehasht, Passwortrichtlinie
- **Zwei-Faktor-Authentifizierung (TOTP)** mit QR-Code und Replay-Schutz; Secrets AES-256-GCM-verschlüsselt gespeichert
- Serverseitige Sitzungen (nur Hash in der DB), `HttpOnly` + `SameSite=Strict` + `Secure` (bei HTTPS, `__Host-`-Präfix), Idle- und absolutes Timeout, Sitzungsübersicht & Abmelden auf allen Geräten
- **CSRF-Schutz** (Synchronizer-Token + Origin-Prüfung + SameSite)
- **Brute-Force-Schutz**: Rate-Limiting pro IP, Kontosperre nach Fehlversuchen, keine Benutzer-Enumeration (konstante Antwortzeit)
- Strenge **Content-Security-Policy** (keine Inline-Skripte/-Styles, keine externen CDNs – Schriften & Bibliotheken werden lokal ausgeliefert), `X-Frame-Options`, `nosniff`, `Referrer-Policy`, HSTS bei HTTPS
- XSS-sicherer Markdown-Renderer (alles escaped, `javascript:`-Links blockiert)
- Container läuft **ohne Root**, mit schreibgeschütztem Dateisystem, ohne Linux-Capabilities und mit `no-new-privileges`
- Schutz vor Aussperren: der letzte aktive Administrator kann nicht entfernt oder herabgestuft werden

## Schnellstart

```bash
git clone https://github.com/jonesmen/rackbook.git
cd rackbook
# optional: .env anpassen
docker compose up -d
```

Danach `http://<server>:3000` öffnen und das Administratorkonto anlegen.

Für den Betrieb werden nur `docker-compose.yml` und `.env` benötigt (z. B. in `/opt/stacks/rackbook` für Dockge/Portainer). Das Image kommt aus `ghcr.io/jonesmen/rackbook`.

Lokal aus dem Quellcode bauen (im geklonten Repo):

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

### Nur mit `docker-compose.yml` und `.env`

Ab einem Release (`v*`-Tag) hängen `docker-compose.yml` und `rackbook.env` (auf die Version festgelegt) am GitHub-Release. Beide in einen Ordner legen, `rackbook.env` in `.env` umbenennen und `docker compose up -d` ausführen. Ist das GHCR-Paket privat, vorher `docker login ghcr.io` ausführen oder das Paket auf GitHub öffentlich stellen.

## Konfiguration

Alle Einstellungen stehen kommentiert in [`.env`](.env). Die wichtigsten:

| Variable | Standard | Bedeutung |
|---|---|---|
| `RACKBOOK_PORT` / `RACKBOOK_BIND` | `3000` / `0.0.0.0` | Port und Bind-Adresse auf dem Host |
| `PUBLIC_URL` | leer | Öffentliche URL, z. B. `https://docs.example.de` (strikte Origin-Prüfung) |
| `TRUST_PROXY` | `false` | Anzahl Reverse Proxys davor (z. B. `1`) |
| `COOKIE_SECURE` | `auto` | Secure-Cookie bei HTTPS |
| `APP_SECRET` | leer | Schlüssel für 2FA-Verschlüsselung; leer = automatisch im Volume erzeugt |
| `SESSION_IDLE_MINUTES` / `SESSION_MAX_DAYS` | `720` / `14` | Sitzungsdauer |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_LOCK_MINUTES` | `5` / `15` | Kontosperre |
| `ALLOW_REGISTRATION` | `false` | Selbstregistrierung (nach dem ersten Admin) |
| `REGISTRATION_REQUIRES_APPROVAL` | `true` | Neue Konten müssen freigeschaltet werden |
| `DEFAULT_ROLE` | `viewer` | Rolle für neu registrierte Benutzer |
| `STALE_DAYS` | `90` | Ab wann Dokumente als „zu prüfen“ gelten |
| `SEED_SAMPLE_DOCS` | `false` | Beispieldokumente beim ersten Start |

Registrierung, Standardrolle und Prüfintervall lassen sich später auch unter **Verwaltung → System** ändern.

## Hinter einem Reverse Proxy (empfohlen, für HTTPS)

`.env`:

```env
RACKBOOK_BIND=127.0.0.1
PUBLIC_URL=https://docs.example.de
TRUST_PROXY=1
```

Beispiel Caddy:

```
docs.example.de {
    reverse_proxy 127.0.0.1:3000
}
```

Beispiel Traefik (Labels in `docker-compose.yml` ergänzen, Port-Mapping entfernen):

```yaml
    labels:
      - traefik.enable=true
      - traefik.http.routers.rackbook.rule=Host(`docs.example.de`)
      - traefik.http.routers.rackbook.entrypoints=websecure
      - traefik.http.routers.rackbook.tls.certresolver=letsencrypt
      - traefik.http.services.rackbook.loadbalancer.server.port=3000
```

## Backup & Wiederherstellung

Alle Daten liegen im Volume `rackbook-data` (SQLite-Datenbank + automatisch erzeugter Schlüssel).

```bash
# Backup (Container kurz stoppen, damit die SQLite-Datei konsistent ist)
docker compose stop
docker run --rm -v rackbook-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/rackbook-$(date +%F).tar.gz -C /data .
docker compose start

# Wiederherstellen
docker compose down
docker run --rm -v rackbook-data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* /data/.app_secret && tar xzf /backup/rackbook-YYYY-MM-DD.tar.gz -C /data"
docker compose up -d
```

Zusätzlich können Administratoren unter **Einstellungen → Daten** ein JSON-Backup aller Dokumente herunterladen und wieder einspielen.

> Wird ein Bind-Mount statt des benannten Volumes verwendet, muss das Verzeichnis dem Benutzer mit UID 1000 gehören (`chown 1000:1000 ./data`).

## Update

```bash
docker compose pull && docker compose up -d
# bzw. bei lokalem Build:
git pull && docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Datenbankmigrationen laufen beim Start automatisch.

## Entwicklung

```bash
npm install
npm run dev      # http://localhost:3000, Daten in ./data
npm test         # API- und Sicherheitstests
```

Aufbau: `server/` (Express 5, `node:sqlite`), `public/` (Preact + htm ohne Build-Schritt). `npm run build` kopiert Schriften und Preact aus `node_modules` nach `public/`.
