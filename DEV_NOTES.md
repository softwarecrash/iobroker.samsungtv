# DEV_NOTES (Legacy Analysis)

## Environment
- Legacy adapter sources found in:
  - `/home/iobroker/ioBroker.samsung-master/ioBroker.samsung-master`
  - `/home/iobroker/ioBroker.samsung_tizen-master/ioBroker.samsung_tizen-master`
- No auto-discovery in either legacy adapter; both require manual IP/config.

## Legacy Adapter: `samsung` (version 0.6.1)
### Config (io-package.json)
- `ip`, `mac`, `token`, `pin`, `apiType` (SamsungRemote | SamsungHJ | Samsung2016 | SamsungTV)

### Object model
- Objects created from `keys.js` via `setObjectNotExists`:
  - Channels: `Power`, `Volume`, `Channel`, `Input`, `Navigation`, `MediaPlayer`
  - States under each channel are booleans (buttons) mapped to remote key names.
- Extra states:
  - `Power.checkOn`, `Power.off`, `Power.on`
  - `Power.checkOnOff` (string state that reflects interim/final ON/OFF)
  - `command` (string; accepts a remote key name)

### Protocols / endpoints / behaviors
- **SamsungRemote** (pre‑2014 TVs) uses `samsung-remote` (legacy HTTP remote)
- **Samsung2016** (Tizen-style WS, insecure):
  - WS URL: `http://<ip>:8001/api/v2/channels/samsung.remote.control?name=<base64>`
  - Sends `ms.remote.control` with `{ Cmd: "Click", DataOfCmd: KEY_*, TypeOfRemote: "SendRemoteKey" }`
- **SamsungTV** (Tizen, secure):
  - API base: `http://<ip>:8001/api/v2/` (device info)
  - WS URL: `wss://<ip>:8002/api/v2/channels/samsung.remote.control?name=<base64>[&token=...]`
  - Token received in `ms.channel.connect` message (`data.data.token`)
  - WOL via `wake_on_lan` if MAC provided
  - **Discovery logic (from bundled samsungtv lib)**:
    - Uses SSDP `node-ssdp` client; `client.search('ssdp:all')`
    - Filters by `headers.SERVER` regex: `Samsung.+UPnP.+SDK/1.0`
    - Captures `LOCATION`, `ST`, `USN` for services
- **SamsungHJ** (2014/2015 H/J series) pairing + socket.io:
  - Device info: `http://<ip>:8001/ms/1.0/` (DeviceID, DeviceName)
  - Pairing UI: `POST http://<ip>:8080/ws/apps/CloudPINPage` (shows PIN)
  - Pairing steps: `http://<ip>:8080/ws/pairing?step=0|1|2&app_id=<appId>&device_id=<deviceId>`
  - Control channel:
    - Start service: `http://<ip>:8000/common/1.0.0/service/startService?appID=com.samsung.companion`
    - Handshake: `http://<ip>:8000/socket.io/1` (session id)
    - WS: `ws://<ip>:8000/socket.io/1/websocket/<session>`
    - Remote key via `callCommon` / plugin `RemoteControl`
- **Power detection** uses ICMP ping (`lib/ping.js`)

### Notable issues to avoid
- Token is logged in plain text when first connecting (`SamsungTV` branch)
- Single-TV only; no stable device IDs or multi-device registry

## Legacy Adapter: `samsung_tizen` (version 1.1.0)
### Config (io-package.json)
- `protocol` (http|wss), `ipAddress`, `port` (8001|8002), `token`, `macAddress`, `cmdDelay`,
  `pollingPort` (9110/9119/9197), `pollingInterval`

### Object model
- `control.KEY_*` (buttons)
- `apps.getInstalledApps` / `apps.start_<name>`
- `config.getToken` (button), `config.token` (created dynamically)
- `powerOn` boolean state (based on port reachability)
- `command.*` macro states (string of comma-separated keys)

### Protocols / endpoints / behaviors
- WS URL: `<protocol>://<ip>:<port>/api/v2/channels/samsung.remote.control?name=<base64>[&token=...]`
- Token fetch: connect without token, read `data.data.token` from `ms.channel.connect`
  - **Token is logged + stored in object name** (insecure)
- Power detection: `is-port-reachable` on `pollingPort`
- Apps:
  - Installed apps: `ms.channel.emit` event `ed.installedApp.get`
  - Launch app: `ms.channel.emit` event `ed.apps.launch` with `action_type` `DEEP_LINK` or `NATIVE_LAUNCH`
- WOL support via `wake_on_lan`

### Notable issues to avoid
- Token exposed in logs and object names
- Single-TV only; manual IP config required
- No discovery

## Takeaways for new adapter
- Reuse known endpoints for device info and pairing:
  - `http://<ip>:8001/api/v2/` (Tizen info)
  - `http://<ip>:8001/ms/1.0/` (HJ device info)
  - HJ pairing on `:8080/ws/pairing` + socket.io on `:8000`
- SSDP discovery in samsungtv lib is a good base (SERVER header match for Samsung UPnP SDK)
- Avoid logging/storing token in plaintext and avoid `config.token` object name leaks
- Plan migration checks for legacy object trees:
  - `samsung.0.Power.*` and `samsung.0.command`
  - `samsung_tizen.0.control.*`, `samsung_tizen.0.apps.*`, `samsung_tizen.0.powerOn`

## Protocol Research (Home Assistant + Samsung TV)
### Home Assistant integration behavior (high-level)
- Samsung Smart TV integration is auto-discoverable in Home Assistant.
- The integration uses a local REST API plus a WebSocket notification/control channel.
- Wake-on-LAN is used for power-on when a MAC is available.
- Samsung TVs require same-subnet access for the WebSocket connection; cross-subnet/VLAN can fail.
- Access notification settings on TV can reduce repeated permission prompts.

Sources:
- https://www.home-assistant.io/integrations/samsungtv

### Discovery methods (Home Assistant)
- SSDP/UPnP discovery is used in HA (Samsung Smart TV is listed among SSDP-discovered integrations).
- Zeroconf (mDNS) is used in the samsungtv config flow (`async_step_zeroconf`).
- Specific Samsung mDNS service names were not found in official docs; treat as best-effort.

Sources:
- https://www.home-assistant.io/integrations/ssdp
- https://github.com/home-assistant/core/issues/54027 (stack trace shows samsungtv `async_step_zeroconf`)

### Tizen REST + WebSocket endpoints (evidence from HA logs)
- REST device info used by HA via `https://<ip>:8002/api/v2/` (returns `TokenAuthSupport`, model, uuid/udn, etc).
- HA tries WebSocket control via:
  - `wss://<ip>:8002/api/v2/channels/samsung.remote.control?name=<base64>&token=...`
  - fallback to `ws://<ip>:8001/api/v2/channels/samsung.remote.control?name=<base64>`

Sources:
- https://github.com/home-assistant/core/issues/104092 (debug logs show REST and WS URLs)

### samsungtvws library (used by HA)
- Supports WebSocket + REST APIs, async/sync, encrypted v1 API for older TVs, CLI utilities, WOL.

Sources:
- https://pypi.org/project/samsungtvws/
