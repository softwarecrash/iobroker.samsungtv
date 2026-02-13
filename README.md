![Logo](admin/samsung.svg)

# iobroker.samsungtv

Modern Samsung TV adapter with automatic discovery and multi-device management in one instance (multiple TVs supported in the same instance).

German documentation is available at `doc/de/README.md`.

## Features
- Automatic discovery via SSDP/UPnP and optional mDNS
- Multiple TVs in one instance: `samsungtv.0.<tvname>.*`
- Tizen WebSocket API (8001/8002) + pairing/token
- H/J series PIN pairing (best effort)
- Wake-on-LAN (optional)
- Stable device matching via ID/UUID/MAC, also across renames
- No token output in logs or UI (tokens are stored encrypted)

## Configuration
In the admin UI:
- **Auto Scan**: periodic discovery
- **Auto Scan Interval (s)**: interval for automatic discovery
- **Discovery Timeout (s)**: scan timeout
- **Enable SSDP** / **Enable mDNS**: discovery sources
- **mDNS Services**: comma-separated service types (best effort)
- **Enable Wake-on-LAN**: enable WOL
- **Power Poll Interval (s)**: interval for power checks

### Add devices
1. Start **Scan**.
2. Add a discovered TV via **Add**.
3. Optionally adjust name/IP.
4. **Save**.

### Pairing
- **Tizen**: when you click **Pair**, the TV shows a prompt (usually **Allow/Cancel**, no PIN). Confirm, then save.
- **H/J series**: click **Pair** → TV shows PIN → enter PIN → save.

Tokens/identities are stored encrypted in the adapter config.

If **no prompt** appears during pairing:
- TV: **Device Connection Manager** → enable **Access Notification**.
- TV: check **Device List** and remove old entries.
- Make sure ioBroker and the TV are on the **same subnet**.

## Object model
Per TV:
- `samsungtv.0.<tvname>.info.*`
  - `id`, `ip`, `mac`, `model`, `uuid`, `api`, `lastSeen`, `paired`, `online`
  - `tokenAuthSupport`, `remoteAvailable` (if reported by the TV)
- `samsungtv.0.<tvname>.state.*`
  - `power`, `volume`, `muted`, `app`, `source`
- `samsungtv.0.<tvname>.control.*`
  - `power`, `wol`, `key`, `volumeUp`, `volumeDown`, `mute`, `channelUp`, `channelDown`, `launchApp`, `source`

### Control (short)
- `control.key`: any remote key (e.g. `KEY_POWER`, `KEY_VOLUP`)
- `control.launchApp`: app ID (Tizen) from the TV app list
- `control.source`: source as key (`KEY_HDMI`, `KEY_SOURCE`) or short form (`HDMI`)

### Key codes (control.key)
`control.key` accepts either **Samsung key codes** (`KEY_*`) or **friendly short forms**:
- Navigation: `up`, `down`, `left`, `right`, `enter`, `back`
- System: `home`, `source`, `menu`, `info`, `guide`, `exit`
- Volume/channel: `volup`, `voldown`, `mute`, `chup`, `chdown`
- Media: `play`, `pause`, `stop`, `rewind`, `ff`, `record`
- Colors: `red`, `green`, `yellow`, `blue`
- Numbers: `0` to `9`

Direct key codes also work:
- Examples: `KEY_UP`, `KEY_DOWN`, `KEY_ENTER`, `KEY_RETURN`, `KEY_HOME`, `KEY_SOURCE`

Note: not every TV supports every key. Some keys only work when a menu/focus is active.

## Notes
- Discovery is best effort. SSDP is primary, mDNS is optional.
- Older devices are detected where possible (HJ/Legacy); feature set may vary.
- For H/J/JU devices, HJ is preferred when available. Tizen remote is attempted otherwise and switches to HJ automatically if the TV reports "unrecognized method".
- If legacy objects exist, warnings are logged.
- Adapter is renamed to `samsungtv` to avoid conflicts with the old `samsung` adapter.
- When installing via URL, an instance is created automatically (skip with `IOBROKER_SKIP_POSTINSTALL=1`).

## Changelog
See `io-package.json` (`common.news`) or the GitHub releases for detailed changes.

## How to test (short)
1. Install the adapter and create an instance.
2. Open admin, start **Scan**.
3. Add a TV and set a name (e.g. `tv-livingroom`).
4. **Save**. Verify object tree `samsungtv.0.tv-livingroom.*`.
5. Run **Pair** and confirm on the TV.
6. Test `control.*` objects (e.g. `control.mute`).
7. Rename the TV and save again: object tree should migrate cleanly.

## License
MIT
