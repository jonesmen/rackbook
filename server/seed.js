// Standard-Ordner und Beispieldokumente (aus dem ursprünglichen UI-Entwurf).
export const DEFAULT_FOLDERS = [
  { id: 'netzwerk', name: 'Netzwerk', icon: 'lan', hue: 250 },
  { id: 'server', name: 'Server & Hardware', icon: 'dns', hue: 70 },
  { id: 'dienste', name: 'Docker-Dienste', icon: 'deployed_code', hue: 155 },
  { id: 'backup', name: 'Backups', icon: 'cloud_sync', hue: 300 },
  { id: 'runbooks', name: 'Runbooks', icon: 'menu_book', hue: 25 },
  { id: 'smarthome', name: 'Smart Home', icon: 'sensors', hue: 205 },
];

const at = (d, h, m) => { const x = new Date(); x.setDate(x.getDate() - d); x.setHours(h, m, 0, 0); return Math.min(x.getTime(), Date.now() - 60000); };
const B = s => s.replace(/§/g, '`');

export const sampleDocs = () => [
  { id: 'vlan', title: 'VLAN-Plan & Subnetze', folder: 'netzwerk', tags: ['netzwerk', 'unifi'], pinned: true, bookmarked: true, updated: at(0, 10, 23), content: B(`Übersicht aller VLANs im Heimnetz. Gateway ist die **UniFi Dream Machine** (§10.0.0.1§).

## VLANs

| ID | Name | Subnetz | Zweck |
|---|---|---|---|
| 10 | Management | 10.0.10.0/24 | Switches, APs, IPMI |
| 20 | Server | 10.0.20.0/24 | Proxmox, NAS |
| 30 | Clients | 10.0.30.0/24 | Laptops, Handys |
| 40 | IoT | 10.0.40.0/24 | Smart Home, isoliert |
| 50 | Gäste | 10.0.50.0/24 | Nur Internet |

## Firewall-Regeln

- IoT → Server: nur §1883/tcp§ (MQTT) zu Home Assistant
- Gäste → alles intern: **blockiert**
- Clients → Management: nur aus der Admin-Gruppe

> [!TIP]
> Änderungen an Regeln immer zuerst hier eintragen, dann umsetzen.

## Offene Punkte

- [ ] mDNS-Reflector zwischen VLAN 30 und 40 testen
- [x] Gäste-WLAN auf eigenes VLAN umziehen
- [ ] IPv6 Prefix Delegation dokumentieren`) },
  { id: 'proxmox', title: 'Proxmox-Cluster', folder: 'server', tags: ['proxmox', 'virtualisierung'], pinned: true, bookmarked: true, updated: at(1, 16, 15), content: B(`Drei Nodes im Cluster §pve-home§, Quorum über alle drei.

## Nodes

| Node | Hardware | RAM | IP |
|---|---|---|---|
| pve-01 | Lenovo M720q, i5-8500T | 32 GB | 10.0.20.11 |
| pve-02 | Lenovo M720q, i5-8500T | 32 GB | 10.0.20.12 |
| pve-03 | HP EliteDesk 800 G4 | 64 GB | 10.0.20.13 |

## Storage

- §local-zfs§ – lokaler NVMe-Pool je Node
- §nas-nfs§ – NFS-Share vom NAS für ISOs und Backups

## Update-Routine

§§§bash
apt update && apt full-upgrade -y
pveversion -v
§§§

Nodes **einzeln** neu starten und warten, bis §pvecm status§ wieder Quorum meldet.

### Offene Punkte

- [ ] pve-03 auf 10 GbE umrüsten
- [ ] Ceph evaluieren`) },
  { id: 'traefik', title: 'Traefik Reverse Proxy', folder: 'dienste', tags: ['docker', 'traefik', 'tls'], pinned: false, bookmarked: false, updated: at(0, 8, 40), content: B(`Traefik v3 läuft als Container auf §docker-01§ und terminiert TLS für alle Dienste unter §*.home.example.de§.

## docker-compose.yml

§§§yaml
services:
  traefik:
    image: traefik:v3.1
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./acme.json:/acme.json
§§§

## Zertifikate

Wildcard-Zertifikat über **Let's Encrypt DNS-Challenge** (Cloudflare). Das API-Token liegt in Vaultwarden unter *Traefik / CF-API*.

## Offene Punkte

- [ ] Middleware für Forward-Auth ergänzen`) },
  { id: 'backup', title: 'Backup-Strategie (3-2-1)', folder: 'backup', tags: ['backup', 'restic'], pinned: true, bookmarked: false, updated: at(3, 19, 2), content: B(`Drei Kopien, zwei Medien, eine davon extern.

1. **Primär:** Proxmox Backup Server auf dem NAS, täglich 02:00
2. **Sekundär:** USB-Platte, wöchentlich rotierend
3. **Extern:** restic → Backblaze B2, verschlüsselt

## Restore testen

Einmal pro Quartal einen zufälligen Container aus B2 wiederherstellen.

§§§bash
restic -r b2:homelab-backup:/pbs snapshots
restic -r b2:homelab-backup:/pbs restore latest --target /tmp/restore
§§§

- [ ] Restore-Test Q4 durchführen
- [x] Restore-Test Q3 durchgeführt`) },
  { id: 'pihole', title: 'Pi-hole & lokales DNS', folder: 'netzwerk', tags: ['dns', 'pihole'], pinned: false, bookmarked: false, updated: at(12, 11, 30), content: B(`Zwei Pi-hole-Instanzen, synchronisiert mit **nebula-sync**.

| Instanz | IP | Host |
|---|---|---|
| pihole-1 | 10.0.20.53 | LXC auf pve-01 |
| pihole-2 | 10.0.20.54 | Raspberry Pi 4 |

## Lokale Einträge

Alle Dienste zeigen per Wildcard §*.home.example.de§ auf Traefik (§10.0.20.20§).

Upstream ist Unbound, rekursiv, ohne DoH.`) },
  { id: 'nas', title: 'NAS – Synology DS920+', folder: 'server', tags: ['nas', 'storage'], pinned: false, bookmarked: false, updated: at(124, 9, 0), content: B(`4× 8 TB WD Red Plus in **SHR-1**, ca. 21 TB nutzbar.

## Freigaben

- §media§ – Filme, Serien, Musik (nur lesen für Jellyfin)
- §backup§ – Ziel für den Proxmox Backup Server
- §homes§ – persönliche Ordner

## Wartung

- Daten-Scrubbing am ersten Sonntag im Monat
- S.M.A.R.T.-Schnelltest wöchentlich

- [ ] Platte 3 zeigt erhöhte Reallocated Sectors – beobachten`) },
  { id: 'strom', title: 'Wiederherstellung nach Stromausfall', folder: 'runbooks', tags: ['runbook', 'notfall'], pinned: false, bookmarked: true, updated: at(203, 14, 10), content: B(`Reihenfolge beim Hochfahren nach einem Stromausfall. Die USV hält ca. 12 Minuten.

1. Modem und **UDM** starten, warten bis WAN aktiv ist
2. Switches und Access Points prüfen
3. NAS einschalten, warten bis das Volume *fehlerfrei* ist
4. Proxmox-Nodes nacheinander starten
5. Dienste prüfen: Pi-hole, Traefik, Home Assistant

> [!WARNING]
> Fehlt das Quorum: §pvecm expected 1§ auf einem Node – nur im Notfall!

## Checkliste danach

- [ ] USV-Log auf Ursache prüfen
- [ ] Backup-Jobs der Nacht kontrollieren`) },
  { id: 'ha', title: 'Home Assistant', folder: 'smarthome', tags: ['homeassistant', 'zigbee'], pinned: false, bookmarked: false, updated: at(5, 20, 45), content: B(`Home Assistant OS als VM auf §pve-02§, erreichbar unter §ha.home.example.de§.

## Integrationen

- **Zigbee2MQTT** mit Sonoff ZBDongle-E (USB-Passthrough)
- **Mosquitto** als MQTT-Broker
- Shelly-Geräte im IoT-VLAN

## Automationen

| Name | Auslöser | Aktion |
|---|---|---|
| Flurlicht | Bewegung nach Sonnenuntergang | Licht 40 % für 3 min |
| Serverschrank warm | Temperatur > 30 °C | Push + Lüfter an |

- [ ] Zigbee-Kanal von 15 auf 25 wechseln`) },
  { id: 'jellyfin', title: 'Jellyfin Mediaserver', folder: 'dienste', tags: ['docker', 'media'], pinned: false, bookmarked: false, updated: at(30, 13, 5), content: B(`Läuft auf §docker-01§ mit Intel Quick Sync für Hardware-Transcoding.

§§§yaml
devices:
  - /dev/dri:/dev/dri
volumes:
  - /mnt/media:/media:ro
§§§

Medien werden per NFS vom NAS eingebunden (nur lesen).`) },
];
