# Rackbook

Selbstgehostete Markdown-Dokumentation für Homelab & IT-Infrastruktur – als ein einziges, gehärtetes Docker-Image mit Mehrbenutzerverwaltung.

## Funktionen

**Dokumentation**
- Dashboard mit angepinnten Dokumenten, zuletzt bearbeiteten Dokumenten und offenen To-dos (`- [ ]` aus allen Dokumenten, direkt abhakbar)
- Ordner mit **Unterordnern** (bis 5 Ebenen, frei anlegbar, mit Icon und Farbe), Tags, Tag-Filter, persönliche Lesezeichen
- **Seitenbaum** in der Seitenleiste: Ordner, Unterordner, Dokumente und Unterseiten – jede Ebene aufklappbar, Seitenleiste per Ziehen verbreiterbar
- **Unterseiten**: Dokumente lassen sich unter einem Hauptdokument anordnen (z. B. ein Projekt mit Unterseiten für Konfiguration, Backup, Runbooks); Brotkrumen-Pfad, Unterseiten-Liste, Verschieben und Löschen samt Unterseiten
- **Block-Editor** (wie Notion): Umschalter **Bearbeiten | Lesen**, automatisches Speichern, `/` öffnet das Einfügemenü, Blöcke per Griff verschieben, Formatierungsleiste bei Markierung, Markdown-Kürzel (`#`, `-`, `1.`, `[]`, `>`), Rückgängig/Wiederholen, optional Markdown-Quelltext
- Blöcke im `/`-Menü: Text, To-do-Liste, Überschrift 1–3, Aufzählung, nummerierte Liste, Zitat, Hinweisblock, Umschaltblock, Code, Tabelle, Trennlinie, Seitenumbruch, Fußnote, Bild, Video, Audio, PDF einbetten, Dateianhang, Base (Inline-Datenbank), Kanban, Mathe (inline & Block, LaTeX), Mermaid-Diagramm, Draw.io, Excalidraw, Unterseiten, synchronisierter Block, Datum, Uhrzeit, Status, Emoji, 2–5 Spalten, iframe, Airtable, Loom, Figma, Typeform, Miro, YouTube, Vimeo, Framer, Google Drive, Google Sheets
- Gespeichert wird weiterhin **Markdown** (mit wenigen Erweiterungen) – Suche, Export und KI-Zugriff funktionieren unverändert
- Dokumentansicht mit Inhaltsverzeichnis, kopierbaren Code-Blöcken, abhakbaren Checklisten, sortierbaren Datenbanken und Druck-/PDF-Ansicht (Seitenumbrüche)
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
- Hochgeladene Dateien: Typ wird am Inhalt erkannt (nicht am Namen), unbekannte Typen nur als Download, SVGs/Bilder mit eigener Sandbox-CSP, Zugriff nur angemeldet bzw. über zeitlich begrenzte signierte Links aus Freigaben
- Externe Einbettungen in abgesicherten iframes (Sandbox, eigener Ursprung) – vom Admin komplett abschaltbar; Mermaid/Excalidraw laufen isoliert und lokal
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

## Single Sign-On mit Authentik (OIDC)

Komplett in der Oberfläche konfigurierbar unter **Verwaltung → Single Sign-On**.

1. In Authentik: **Anwendungen → Provider → Erstellen → OAuth2/OpenID-Provider**
   - Client-Typ: `Confidential`
   - Redirect-URI (strict): die in Rackbook angezeigte Adresse, z. B. `https://docs.example.de/api/auth/oidc/callback`
   - Scopes: `openid`, `profile`, `email` (Standard-Mappings – `profile` liefert in Authentik auch den Claim `groups`)
2. **Anwendungen → Anwendungen → Erstellen**, Provider auswählen, Slug z. B. `rackbook`.
3. In Rackbook eintragen:
   - Issuer-URL: `https://auth.example.de/application/o/rackbook/`
   - Client-ID und Client-Secret aus dem Provider
   - Optional Gruppen: *Erlaubte Gruppen*, *Administrator-Gruppen*, *Bearbeiter-Gruppen* (Namen der Authentik-Gruppen)
4. **Speichern & Verbindung testen**, dann *Single Sign-On aktivieren*.

Weitere Optionen: Benutzer automatisch anlegen, Rollen bei jeder Anmeldung aus Gruppen synchronisieren, Anzeigename bei jeder Anmeldung übernehmen (standardmäßig aus – der Name wird nur beim ersten Login übernommen und kann danach in Rackbook geändert werden), bestehende Konten über den Benutzernamen verknüpfen, Passwort-Anmeldung deaktivieren (Administratoren behalten einen Notfallzugang), automatische Weiterleitung zum Provider (Notfallzugang über `/?local`) und Abmelden beim Provider.

Sicherheit: Authorization Code Flow mit PKCE (S256), `state` und `nonce`, Signaturprüfung des ID-Tokens über die JWKS des Providers (`openid-client`). Das Client-Secret wird verschlüsselt gespeichert und nie wieder an den Browser ausgeliefert. Zwei-Faktor-Schutz für SSO-Benutzer übernimmt Authentik.

Damit die Redirect-URI mit `https://` erzeugt wird, hinter dem Reverse Proxy `PUBLIC_URL` und `TRUST_PROXY=1` setzen. Nutzt Authentik ein Zertifikat einer eigenen CA, das CA-Zertifikat in den Container mounten und `NODE_EXTRA_CA_CERTS` setzen (siehe `.env`).

## Editor

Jedes Dokument hat oben rechts den Umschalter **Bearbeiten | Lesen**. Im Bearbeiten-Modus wird automatisch gespeichert (pro Bearbeitungssitzung entsteht eine Version im Versionsverlauf). In den persönlichen Einstellungen lässt sich festlegen, ob Dokumente standardmäßig zum Lesen oder Bearbeiten geöffnet werden.

- **`/`** am Zeilenanfang (oder nach einem Leerzeichen) öffnet das Menü mit allen Blöcken; Weitertippen filtert („tab“, „yt“, „spalten“ …), `↑`/`↓` + `Enter` wählt aus.
- Links neben jedem Block: **`+`** (Block darunter einfügen) und **`⋮⋮`** (ziehen zum Verschieben, klicken für Umwandeln, Duplizieren, Löschen).
- Dateien per Upload, Drag & Drop oder Einfügen aus der Zwischenablage (Bilder). Größenlimit und Uploads unter **Verwaltung → System → Editor & Medien**.
- **Excalidraw** und **Mermaid** sind im Image enthalten und laufen komplett lokal. **Draw.io** nutzt standardmäßig `https://embed.diagrams.net` (die Diagrammdaten bleiben im Browser); alternativ einen eigenen Draw.io-Container (z. B. `jgraph/drawio`) eintragen.
- **Synchronisierte Blöcke** werden einmal angelegt und können in beliebig vielen Dokumenten eingefügt werden – Änderungen erscheinen überall.
- **Externe Inhalte** (YouTube, Figma, Miro, Google Drive, iframes, Bilder per https) lassen sich unter **Editor & Medien** abschalten; dann werden nur Links angezeigt und die CSP erlaubt keine fremden Quellen.

Format der Erweiterungen (falls Dokumente per Hand oder per KI geschrieben werden): `> [!NOTE]` Hinweisblock, `:::toggle Titel … :::`, `:::columns` / `:::column … :::`, ` ```mermaid `, ` ```math `, `$…$`, `{{date:2026-01-31}}`, `{{status:Offen|red}}`, `[^1]` Fußnoten, `::pagebreak`, `::subpages`, `::embed {"url":"…"}`. Hinweis: Eine einfache Zeile mit `>` ist jetzt ein **Zitat**; für den farbigen Hinweis `> [!NOTE]` verwenden.

## Teilen per Link (ohne Konto)

Seiten (optional mit Unterseiten) und ganze Ordner (optional mit Unterordnern) lassen sich über das Teilen-Symbol als **nur lesender Link** freigeben – ohne Konto für den Empfänger.

- **Wer darf teilen:** Administratoren alles, Bearbeiter nur selbst erstellte Seiten und Ordner. In geteilten Ordnern oder Seiten von Nicht-Admins erscheinen nur deren eigene Seiten.
- **Übersicht & Widerruf:** Einstellungen → *Geteilte Links* (eigene Freigaben mit Aufrufzahl, Ablauf, Passwortschutz).
- **Verwaltung → Freigaben:** Teilen an/aus, maximale und Standard-Gültigkeit, Passwortpflicht, Bearbeiter-Erlaubnis, alle aktiven Links. Administratoren können das Maximum beim Teilen überschreiben.
- **Verwaltung → Benutzer:** „Privat machen“ widerruft alle Freigaben eines Benutzers auf einmal.

Sicherheit:
- Link-Format `https://<rackbook>/share#<Token>`: 256-Bit-Zufallstoken im URL-Fragment. Es wird nie an den Server als URL übertragen und taucht daher in keinem Server-, Proxy- oder Referrer-Log auf; gespeichert wird nur ein Hash.
- Optionales Passwort (scrypt), höchstens 5 Fehlversuche pro 15 Minuten.
- Bei jedem Aufruf wird neu geprüft: Teilen aktiviert, Link nicht abgelaufen oder widerrufen, Ersteller aktiv und weiterhin berechtigt.
- Nur lesend; Verweise auf nicht geteilte Dokumente werden entschärft, Elternverweise außerhalb der Freigabe abgeschnitten.
- `noindex`, `no-referrer`, strenge CSP und Rate-Limit pro IP.

## KI-Assistenten anbinden (MCP-Server)

Rackbook enthält einen leichtgewichtigen [MCP](https://modelcontextprotocol.io)-Server (Streamable HTTP, zustandslos) unter `https://<rackbook>/mcp`. Damit kann eine KI (Claude Code, Claude Desktop, Cursor, VS Code, LibreChat …) Dokumentation lesen und pflegen.

1. **Verwaltung → KI-Zugriff**: MCP-Server aktivieren und festlegen, was KIs maximal dürfen (Lesen, Schreiben, Löschen, Ordner anlegen), maximale Token-Laufzeit, Rate-Limit, Tag für KI-Änderungen und eigene **Hausregeln** für die KI.
2. **Einstellungen → KI-Zugriff (MCP)**: persönliches Token erstellen – mit Rechten (höchstens die eigene Rolle), optionaler Beschränkung auf Ordner und Gültigkeit. Das Token wird nur einmal angezeigt, zusammen mit fertigen Konfigurationen:

```bash
# Claude Code
claude mcp add --transport http rackbook https://docs.example.de/mcp \
  --header "Authorization: Bearer rbm_…"
```

```json
// Claude Desktop (claude_desktop_config.json)
{ "mcpServers": { "rackbook": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://docs.example.de/mcp", "--header", "Authorization:${AUTH}"],
  "env": { "AUTH": "Bearer rbm_…" } } } }
```

**Damit die KI weiß, wie und wo sie dokumentiert**, bekommt sie beim Verbinden eine Anleitung: den Ordnerbaum mit IDs, die Regel „pro Projekt ein Hauptdokument mit Unterseiten“, vorhandene Tags, unterstütztes Markdown, empfohlene Strukturen für Dienste, Hosts und Runbooks, Regeln (erst suchen, dann schreiben; keine Geheimnisse speichern; nichts erfinden) sowie die Hausregeln aus der Verwaltung.

| Werkzeug | Recht | Zweck |
|---|---|---|
| `rackbook_overview` | Lesen | Anleitung, Ordner, Tags, zuletzt geändert |
| `search_documents`, `list_documents`, `get_document`, `list_open_todos` | Lesen | Suchen und Lesen |
| `create_document` | Schreiben | Neues Dokument (mit Duplikatprüfung) |
| `append_to_document` | Schreiben | Text an einen Abschnitt anhängen |
| `replace_in_document` | Schreiben | Eindeutige Textstelle ersetzen |
| `update_document` | Schreiben | Komplett überarbeiten (mit Versionsprüfung) |
| `delete_document` | Löschen | In den Papierkorb verschieben |
| `create_folder` | Ordner | Neuen Ordner anlegen |

Dazu Vorlagen (Prompts) `dienst_dokumentieren`, `host_dokumentieren`, `runbook_erstellen`, `dokumentation_pruefen` und Ressourcen (`rackbook://guide`, `rackbook://doc/{id}`).

Sicherheit: Tokens werden nur als Hash gespeichert und lassen sich jederzeit widerrufen (auch durch Admins). Die effektiven Rechte werden bei **jeder** Anfrage neu berechnet (Token ∩ aktuelle Rolle ∩ Systemeinstellungen) – eine Herabstufung oder das Abschalten wirkt sofort. Jede KI-Änderung wird versioniert, im Audit-Log mit Token-Namen protokolliert und im Dokument als „KI“ gekennzeichnet. Fremde Browser-Origins werden abgewiesen (Schutz vor DNS-Rebinding), Sitzungs-Cookies gelten für `/mcp` nicht.

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

Zusätzlich können Administratoren unter **Einstellungen → Daten** ein JSON-Backup aller Dokumente bzw. ein **Komplett-Backup inkl. hochgeladener Dateien und synchronisierter Blöcke** herunterladen und wieder einspielen. Hochgeladene Dateien liegen im Volume unter `files/`.

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
