![Logo](../../admin/samsung.svg)

# iobroker.samsungtv

Moderner Samsung-TV-Adapter mit automatischer Discovery und Multi-Device-Management in einer einzigen Instanz.

## Features
- Automatische Discovery via SSDP/UPnP und optional mDNS
- Mehrere TVs in einer Instanz: `samsungtv.0.<tvname>.*`
- Tizen WebSocket API (8001/8002) + Pairing/Token
- H/J-Serie PIN-Pairing (best effort)
- Wake-on-LAN (optional)
- Stabiler Geräteabgleich via ID/UUID/MAC, auch bei Namensänderungen
- Keine Token-Ausgabe in Logs oder UI (Token verschlüsselt gespeichert)

## Konfiguration
In der Admin-Oberfläche:
- **Auto Scan**: periodische Discovery
- **Auto Scan Interval (s)**: Intervall für automatische Discovery
- **Discovery Timeout (s)**: Timeout für Scan
- **Enable SSDP** / **Enable mDNS**: Discovery-Quellen
- **mDNS Services**: Komma-getrennte Service-Typen (best effort)
- **Enable Wake-on-LAN**: WOL aktivieren
- **Power Poll Interval (s)**: Intervall für Power-Check

### Geräte hinzufügen
1. **Scan** starten.
2. Gefundenes TV-Gerät per **Add** hinzufügen.
3. Optional Name/IP anpassen.
4. **Speichern**.

### Pairing
- **Tizen**: Bei **Pair** erscheint ein Hinweis am TV (meist **Zulassen/Abbrechen**, kein PIN). Bestätigen, dann speichern.
- **H/J-Serie**: **Pair** klicken → TV zeigt PIN → PIN eingeben → speichern.

Token/Identitäten werden verschlüsselt im Adapter-Config gespeichert.

Falls beim Pairing **kein Hinweis** erscheint:
- TV: **Geräte-Verbindungsmanager / Device Connection Manager** → **Zugriffsbenachrichtigung** aktivieren.
- TV: **Geräteliste** prüfen und alte Einträge entfernen.
- ioBroker und TV im **gleichen Subnetz** betreiben.

## Objektmodell
Pro TV:
- `samsungtv.0.<tvname>.info.*`
  - `id`, `ip`, `mac`, `model`, `uuid`, `api`, `lastSeen`, `paired`, `online`
  - `tokenAuthSupport`, `remoteAvailable` (falls vom TV gemeldet)
- `samsungtv.0.<tvname>.state.*`
  - `power`, `volume`, `muted`, `app`, `source`
- `samsungtv.0.<tvname>.control.*`
  - `power`, `wol`, `key`, `volumeUp`, `volumeDown`, `mute`, `channelUp`, `channelDown`, `launchApp`, `source`

### Steuerung (Kurz)
- `control.key`: beliebiger Remote-Key (z.B. `KEY_POWER`, `KEY_VOLUP`)
- `control.launchApp`: App-ID (Tizen) aus der TV-App-Liste
- `control.source`: Quelle als Key (`KEY_HDMI`, `KEY_SOURCE`) oder Kurzform (`HDMI`)

### Key-Codes (control.key)
`control.key` akzeptiert entweder **Samsung Key-Codes** (`KEY_*`) oder **freundliche Kurzformen**:
- Navigation: `up`, `down`, `left`, `right`, `enter`, `back`
- System: `home`, `source`, `menu`, `info`, `guide`, `exit`
- Lautstärke/Kanal: `volup`, `voldown`, `mute`, `chup`, `chdown`
- Media: `play`, `pause`, `stop`, `rewind`, `ff`, `record`
- Farben: `red`, `green`, `yellow`, `blue`
- Ziffern: `0` bis `9`

Direkte Key-Codes funktionieren ebenfalls:
- Beispiele: `KEY_UP`, `KEY_DOWN`, `KEY_ENTER`, `KEY_RETURN`, `KEY_HOME`, `KEY_SOURCE`

Hinweis: Nicht jeder TV unterstützt jeden Key. Manche Keys wirken nur, wenn ein Menü/Fokus aktiv ist.

## Hinweise
- Discovery ist best effort. SSDP ist primär, mDNS optional.
- Ältere Geräte werden nach Möglichkeit erkannt (HJ/Legacy), Feature-Umfang kann variieren.
- Bei H/J/JU-Geräten wird HJ bevorzugt, wenn verfügbar. Tizen-Remote wird ansonsten versucht und bei „unrecognized method“ automatisch auf HJ umgestellt.
- Falls Legacy-Objekte existieren, werden Warnungen im Log ausgegeben.
- Adapter wurde auf `samsungtv` umbenannt, um Konflikte mit dem alten `samsung`-Adapter zu vermeiden.
- Bei Installation über URL wird eine Instanz automatisch angelegt. (Überspringen mit `IOBROKER_SKIP_POSTINSTALL=1`)

## Changelog
Siehe `io-package.json` (`common.news`) oder die GitHub-Releases für Details.

## How to test (Kurz)
1. Adapter installieren und Instanz anlegen.
2. Admin öffnen, **Scan** starten.
3. TV hinzufügen und Namen (z.B. `tv-wohnzimmer`) setzen.
4. **Speichern**. Prüfen, ob Objektbaum `samsungtv.0.tv-wohnzimmer.*` erscheint.
5. **Pair** ausführen und am TV bestätigen.
6. In den Objekten `control.*` testen (z.B. `control.mute`).
7. TV umbenennen und erneut speichern: Objektbaum soll sauber migriert werden.

## Lizenz
MIT
