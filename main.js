"use strict";

const utils = require("@iobroker/adapter-core");
const { Client: SsdpClient } = require("node-ssdp");
const { Bonjour } = require("bonjour-service");
const WebSocket = require("ws");
const wol = require("wake_on_lan");
const fetch = require("node-fetch");
const https = require("https");
const net = require("net");
const { XMLParser } = require("fast-xml-parser");
const LegacyRemote = require("./lib/legacy/LegacyRemote");
const SamsungHJ = require("./lib/hj/SamsungTv");

const HJ_DEVICE_CONFIG = {
    appId: "721b6fce-4ee6-48ba-8045-955a539edadb",
    userId: "654321"
};

const WS_CONNECT_TIMEOUT = 5000;
const WS_SEND_DELAY = 200;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const xmlParser = new XMLParser({ ignoreAttributes: false });

let adapter;

let devicesById = new Map();
let devicesByName = new Map();
let devicesByMac = new Map();
let discoveredByIp = new Map();
let tokens = { tizen: {}, hj: {} };
let lastDiscovery = 0;

let pollTimer;
let scanTimer;

function createAdapter() {
    return new utils.Adapter({
        name: "samsungtv",
        ready: main,
        stateChange: onStateChange,
        message: onMessage,
        unload: onUnload
    });
}

async function onUnload(callback) {
    try {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        if (scanTimer) {
            clearInterval(scanTimer);
            scanTimer = null;
        }
        callback();
    } catch (e) {
        callback();
    }
}

function sanitizeName(name) {
    if (!name || typeof name !== "string") return "";
    const cleaned = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "")
        .replace(/--+/g, "-");
    return cleaned;
}

function ensureUniqueName(desired, existingSet, fallbackBase) {
    let name = desired || fallbackBase || "tv";
    if (!existingSet.has(name)) return name;
    let i = 2;
    while (existingSet.has(`${name}-${i}`)) i++;
    return `${name}-${i}`;
}

function normalizeId(id) {
    if (!id || typeof id !== "string") return "";
    return id.replace(/^uuid:/i, "").replace(/^urn:uuid:/i, "").trim();
}

function normalizeMac(mac) {
    if (!mac || typeof mac !== "string") return "";
    return mac.trim().toLowerCase();
}

function loadTokensFromConfig() {
    tokens = { tizen: {}, hj: {} };
    if (!adapter.config.tokens) return;
    if (typeof adapter.config.tokens !== "string") return;
    try {
        const parsed = JSON.parse(adapter.config.tokens);
        if (parsed && typeof parsed === "object") {
            tokens.tizen = parsed.tizen || {};
            tokens.hj = parsed.hj || {};
        }
    } catch (e) {
        adapter.log.warn("Could not parse encrypted tokens from config.");
    }
}

async function migrateLegacyConfigFromSamsung() {
    if (adapter.name === "samsung") return false;
    if (adapter.config && adapter.config.migratedFromSamsung) return false;

    const hasDevices = Array.isArray(adapter.config.devices) && adapter.config.devices.length > 0;
    if (hasDevices) return false;

    let legacy;
    try {
        legacy = await adapter.getForeignObjectAsync("system.adapter.samsung.0");
    } catch (e) {
        legacy = null;
    }
    if (!legacy || !legacy.native) return false;

    const merged = { ...adapter.config, ...legacy.native, migratedFromSamsung: true };
    try {
        await adapter.extendForeignObjectAsync(`system.adapter.${adapter.namespace}`, { native: merged });
        adapter.config = merged;
        adapter.log.info("Imported configuration from legacy samsung.0 adapter.");
        return true;
    } catch (e) {
        adapter.log.warn(`Could not import legacy samsung.0 config: ${e.message}`);
        return false;
    }
}

function getTizenToken(deviceId) {
    return (tokens.tizen && tokens.tizen[deviceId]) || "";
}

function getHjIdentity(deviceId) {
    return (tokens.hj && tokens.hj[deviceId]) || null;
}

function setInMemoryToken(deviceId, tokenValue) {
    if (!tokens.tizen) tokens.tizen = {};
    tokens.tizen[deviceId] = tokenValue;
}

function setInMemoryHjIdentity(deviceId, identity) {
    if (!tokens.hj) tokens.hj = {};
    tokens.hj[deviceId] = identity;
}

function getConfiguredDevices() {
    const list = Array.isArray(adapter.config.devices) ? adapter.config.devices : [];
    const existingNames = new Set();
    const result = [];

    for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const id = normalizeId(raw.id || raw.uuid || raw.usn || "");
        if (!id) {
            adapter.log.warn("Skipping device without stable id in config.");
            continue;
        }
        const rawName = raw.name || raw.friendlyName || raw.model || "tv";
        const safeName = ensureUniqueName(sanitizeName(rawName) || `tv-${id.slice(0, 6)}`, existingNames, `tv-${id.slice(0, 6)}`);
        existingNames.add(safeName);

        const device = {
            id,
            name: safeName,
            displayName: rawName,
            ip: raw.ip || "",
            mac: normalizeMac(raw.mac || ""),
            model: raw.model || "",
            api: raw.api || "unknown",
            protocol: raw.protocol || "",
            port: raw.port || 0,
            uuid: raw.uuid || "",
            source: raw.source || "config"
        };
        result.push(device);
    }
    return result;
}

async function checkLegacyObjects() {
    const namespaces = [adapter.namespace];
    if (adapter.name !== "samsung") namespaces.push("samsung.0");
    const legacyIds = [];
    for (const ns of namespaces) {
        legacyIds.push(
            `${ns}.Power`,
            `${ns}.command`,
            `${ns}.control`,
            `${ns}.apps`,
            `${ns}.config`
        );
    }
    try {
        const found = [];
        for (const id of legacyIds) {
            const obj = await adapter.getForeignObjectAsync(id);
            if (obj) found.push(id);
        }
        if (found.length) {
            adapter.log.warn(
                "Legacy Samsung adapter objects detected in the same namespace. " +
                "Please remove or migrate old objects to avoid conflicts. Found: " +
                found.join(", ")
            );
        }
        if (adapter.name !== "samsung") {
            try {
                const legacyInstance = await adapter.getForeignObjectAsync("system.adapter.samsung.0");
                if (legacyInstance) {
                    adapter.log.info("Legacy adapter instance samsung.0 detected. Disable/remove it after migration to avoid confusion.");
                }
            } catch (e) {
                // ignore
            }
        }
    } catch (e) {
        // ignore
    }
}

async function migrateDeviceNames(devices) {
    const startKey = `${adapter.namespace}.`;
    const endKey = `${adapter.namespace}.\u9999`;
    let view;
    try {
        view = await adapter.getObjectViewAsync("system", "device", { startkey: startKey, endkey: endKey });
    } catch (e) {
        view = null;
    }

    const deviceObjects = [];
    if (view && view.rows) {
        for (const row of view.rows) {
            if (row.value && row.value.type === "device") {
                deviceObjects.push({ _id: row.id, obj: row.value });
            }
        }
    } else {
        // fallback: brute force
        try {
            const objs = await adapter.getForeignObjectsAsync(`${adapter.namespace}.*`);
            for (const id of Object.keys(objs)) {
                const obj = objs[id];
                if (obj && obj.type === "device") {
                    deviceObjects.push({ _id: id, obj });
                }
            }
        } catch (e) {
            // ignore
        }
    }

    for (const device of devices) {
        const desiredPrefix = `${adapter.namespace}.${device.name}`;
        const existing = deviceObjects.find((entry) => entry.obj && entry.obj.native && entry.obj.native.deviceId === device.id);
        if (existing && existing._id !== desiredPrefix) {
            adapter.log.info(`Renaming device objects ${existing._id} -> ${desiredPrefix}`);
            await renamePrefix(existing._id, desiredPrefix);
        }
    }
}

async function renamePrefix(oldPrefix, newPrefix) {
    if (!oldPrefix || !newPrefix || oldPrefix === newPrefix) return;
    const objs = await adapter.getForeignObjectsAsync(`${oldPrefix}.*`);
    const allIds = Object.keys(objs);
    allIds.push(oldPrefix); // include root device object

    // Create new objects first
    for (const oldId of allIds) {
        const obj = oldId === oldPrefix ? await adapter.getForeignObjectAsync(oldId) : objs[oldId];
        if (!obj) continue;
        const newId = oldId.replace(oldPrefix, newPrefix);
        const newObj = { ...obj, _id: newId };
        try {
            await adapter.setForeignObjectAsync(newId, newObj);
            if (obj.type === "state") {
                const state = await adapter.getForeignStateAsync(oldId);
                if (state) {
                    await adapter.setForeignStateAsync(newId, state);
                }
            }
        } catch (e) {
            adapter.log.warn(`Failed to create renamed object ${newId}: ${e.message}`);
        }
    }

    // Delete old objects
    for (const oldId of allIds.sort((a, b) => b.length - a.length)) {
        try {
            await adapter.delForeignObjectAsync(oldId, { recursive: false });
        } catch (e) {
            // ignore
        }
    }
}

async function ensureDeviceObjects(device) {
    const base = device.name;
    await adapter.setObjectNotExistsAsync(base, {
        type: "device",
        common: { name: device.displayName || device.name },
        native: { deviceId: device.id }
    });

    await adapter.setObjectNotExistsAsync(`${base}.info`, {
        type: "channel",
        common: { name: "Info" },
        native: {}
    });

    await adapter.setObjectNotExistsAsync(`${base}.state`, {
        type: "channel",
        common: { name: "State" },
        native: {}
    });

    await adapter.setObjectNotExistsAsync(`${base}.control`, {
        type: "channel",
        common: { name: "Control" },
        native: {}
    });

    await ensureState(`${base}.info.id`, "Stable ID", "string", "info.serial", device.id, true);
    await ensureState(`${base}.info.ip`, "IP", "string", "info.ip", device.ip || "", true);
    await ensureState(`${base}.info.mac`, "MAC", "string", "info.mac", device.mac || "", true);
    await ensureState(`${base}.info.model`, "Model", "string", "info.name", device.model || "", true);
    await ensureState(`${base}.info.uuid`, "UUID", "string", "info.uuid", device.uuid || "", true);
    await ensureState(`${base}.info.api`, "API", "string", "info.name", device.api || "", true);
    await ensureState(`${base}.info.lastSeen`, "Last Seen", "number", "value.time", 0, true);
    await ensureState(`${base}.info.paired`, "Paired", "boolean", "indicator", false, true);
    await ensureState(`${base}.info.online`, "Online", "boolean", "indicator.reachable", false, true);

    await ensureState(`${base}.state.power`, "Power", "boolean", "indicator.power", false, true);
    await ensureState(`${base}.state.volume`, "Volume", "number", "value.volume", 0, true);
    await ensureState(`${base}.state.muted`, "Muted", "boolean", "indicator.mute", false, true);
    await ensureState(`${base}.state.app`, "App", "string", "text", "", true);
    await ensureState(`${base}.state.source`, "Source", "string", "text", "", true);

    await ensureState(`${base}.control.power`, "Power", "boolean", "switch", false, false);
    await ensureState(`${base}.control.wol`, "Wake", "boolean", "button", false, false);
    await ensureState(`${base}.control.key`, "Key", "string", "text", "", false);
    await ensureState(`${base}.control.volumeUp`, "Volume Up", "boolean", "button", false, false);
    await ensureState(`${base}.control.volumeDown`, "Volume Down", "boolean", "button", false, false);
    await ensureState(`${base}.control.mute`, "Mute", "boolean", "button", false, false);
    await ensureState(`${base}.control.channelUp`, "Channel Up", "boolean", "button", false, false);
    await ensureState(`${base}.control.channelDown`, "Channel Down", "boolean", "button", false, false);
    await ensureState(`${base}.control.launchApp`, "Launch App", "string", "text", "", false);
    await ensureState(`${base}.control.source`, "Source", "string", "text", "", false);
}

async function ensureState(id, name, type, role, def, readOnly) {
    await adapter.setObjectNotExistsAsync(id, {
        type: "state",
        common: {
            name,
            type,
            role,
            read: true,
            write: !readOnly,
            def
        },
        native: {}
    });
    if (def !== undefined) {
        await adapter.setStateAsync(id, def, true);
    }
}

async function main() {
    await migrateLegacyConfigFromSamsung();
    loadTokensFromConfig();
    await checkLegacyObjects();

    const devices = getConfiguredDevices();
    await migrateDeviceNames(devices);

    devicesById = new Map();
    devicesByName = new Map();
    devicesByMac = new Map();
    for (const device of devices) {
        devicesById.set(device.id, device);
        devicesByName.set(device.name, device);
        if (device.mac) devicesByMac.set(device.mac, device);
    }

    for (const device of devices) {
        await ensureDeviceObjects(device);
        await updateDeviceInfoStates(device);
    }

    adapter.subscribeStates("*.control.*");

    const pollInterval = Math.max(10, parseInt(adapter.config.pollInterval, 10) || 30) * 1000;
    pollTimer = setInterval(pollDevices, pollInterval);
    await pollDevices();

    if (adapter.config.autoScan) {
        const interval = Math.max(30, parseInt(adapter.config.autoScanInterval, 10) || 300) * 1000;
        scanTimer = setInterval(() => performDiscovery(true), interval);
        await performDiscovery(true);
    }
}

async function updateDeviceInfoStates(device) {
    const base = device.name;
    await adapter.setStateAsync(`${base}.info.ip`, device.ip || "", true);
    await adapter.setStateAsync(`${base}.info.mac`, device.mac || "", true);
    await adapter.setStateAsync(`${base}.info.model`, device.model || "", true);
    await adapter.setStateAsync(`${base}.info.uuid`, device.uuid || "", true);
    await adapter.setStateAsync(`${base}.info.api`, device.api || "", true);
    await adapter.setStateAsync(`${base}.info.paired`, isDevicePaired(device), true);
}

function isDevicePaired(device) {
    if (device.api === "tizen") {
        return !!getTizenToken(device.id);
    }
    if (device.api === "hj") {
        return !!getHjIdentity(device.id);
    }
    return false;
}

async function pollDevices() {
    for (const device of devicesById.values()) {
        try {
            const online = await checkDeviceOnline(device);
            await adapter.setStateAsync(`${device.name}.info.online`, online, true);
            await adapter.setStateAsync(`${device.name}.state.power`, online, true);
        } catch (e) {
            // ignore
        }
    }
}

async function checkDeviceOnline(device) {
    if (!device.ip) {
        await refreshIpFromMac(device);
        if (!device.ip) return false;
    }

    let online = await checkDeviceOnlineWithIp(device);
    if (!online && device.mac) {
        const updated = await refreshIpFromMac(device);
        if (updated) {
            online = await checkDeviceOnlineWithIp(device);
        }
    }
    return online;
}

async function checkDeviceOnlineWithIp(device) {
    if (!device.ip) return false;

    if (device.api === "tizen") {
        const info = await fetchTizenInfo(device.ip, device.protocol || "wss", device.port || 8002, 1500);
        if (info) {
            markSeen(device);
            return true;
        }
        // fallback to 8001
        const info2 = await fetchTizenInfo(device.ip, "ws", 8001, 1500);
        if (info2) {
            markSeen(device);
            return true;
        }
    } else if (device.api === "hj") {
        const ok = await checkPort(device.ip, 8000, 1500);
        if (ok) {
            markSeen(device);
            return true;
        }
    } else if (device.api === "legacy") {
        const ok = await checkPort(device.ip, 55000, 1500);
        if (ok) {
            markSeen(device);
            return true;
        }
    }

    // generic fallback: ping port 8001
    const okGeneric = await checkPort(device.ip, 8001, 1000);
    if (okGeneric) {
        markSeen(device);
        return true;
    }
    return false;
}

function markSeen(device) {
    const ts = Date.now();
    adapter.setState(`${device.name}.info.lastSeen`, ts, true);
}

function onStateChange(id, state) {
    if (!state || state.ack) return;
    const parts = id.split(".");
    if (parts.length < 5) return;
    if (`${parts[0]}.${parts[1]}` !== adapter.namespace) return;

    const deviceName = parts[2];
    const channel = parts[3];
    const command = parts[4];

    if (channel !== "control") return;

    const device = devicesByName.get(deviceName);
    if (!device) {
        adapter.log.warn(`Unknown device for stateChange: ${deviceName}`);
        return;
    }

    handleControl(device, id, command, state.val).catch((e) => {
        adapter.log.warn(`Failed to execute ${command} for ${device.name}: ${e.message}`);
    });
}

async function handleControl(device, id, command, value) {
    switch (command) {
        case "power":
            await setPower(device, !!value);
            await adapter.setStateAsync(id, !!value, true);
            return;
        case "wol":
            if (adapter.config.enableWol && device.mac) {
                wol.wake(device.mac);
                await adapter.setStateAsync(id, false, true);
            }
            return;
        case "key":
            if (typeof value === "string" && value.trim()) {
                await sendKey(device, value.trim());
                await adapter.setStateAsync(id, "", true);
            }
            return;
        case "volumeUp":
            return sendButton(device, id, "KEY_VOLUP", value);
        case "volumeDown":
            return sendButton(device, id, "KEY_VOLDOWN", value);
        case "mute":
            return sendButton(device, id, "KEY_MUTE", value);
        case "channelUp":
            return sendButton(device, id, "KEY_CHUP", value);
        case "channelDown":
            return sendButton(device, id, "KEY_CHDOWN", value);
        case "launchApp":
            if (typeof value === "string" && value.trim()) {
                await launchApp(device, value.trim());
                await adapter.setStateAsync(id, "", true);
            }
            return;
        case "source":
            if (typeof value === "string" && value.trim()) {
                await selectSource(device, value.trim());
                await adapter.setStateAsync(id, "", true);
            }
            return;
        default:
            return;
    }
}

async function sendButton(device, id, key, value) {
    if (!key) return;
    if (isTruthyValue(value)) {
        await sendKey(device, key);
        await adapter.setStateAsync(id, false, true);
    }
}

function isTruthyValue(val) {
    return val === true || val === 1 || val === "true";
}

async function setPower(device, on) {
    const online = await checkDeviceOnline(device);
    if (on) {
        if (online) {
            return;
        }
        if (adapter.config.enableWol && device.mac) {
            wol.wake(device.mac);
        }
        return;
    }
    if (online) {
        await sendKey(device, "KEY_POWER");
    }
}

async function sendKey(device, key) {
    if (device.api === "tizen") {
        await tizenSendKey(device, key);
    } else if (device.api === "hj") {
        await hjSendKey(device, key);
    } else if (device.api === "legacy") {
        await legacySendKey(device, key);
    } else {
        // try tizen first
        try {
            await tizenSendKey(device, key);
        } catch (e) {
            await legacySendKey(device, key);
        }
    }
    markSeen(device);
}

async function legacySendKey(device, key) {
    if (!device.ip) throw new Error("No IP");
    await new Promise((resolve, reject) => {
        const remote = new LegacyRemote({ ip: device.ip });
        remote.send(key, (err) => (err ? reject(err) : resolve()));
    });
}

async function hjSendKey(device, key) {
    if (!device.ip) throw new Error("No IP");
    const tv = new SamsungHJ({ ...HJ_DEVICE_CONFIG, ip: device.ip });
    await tv.init2();
    const identity = getHjIdentity(device.id);
    if (!identity) throw new Error("Not paired (HJ)" );
    tv.identity = identity;
    if (tv.pairing) {
        tv.pairing.identity = identity;
    }
    await tv.connect();
    tv.sendKey(key);
}

async function launchApp(device, appId) {
    if (device.api !== "tizen") {
        adapter.log.warn(`launchApp only supported for Tizen devices (${device.name})`);
        return;
    }
    await tizenSend(device, {
        method: "ms.channel.emit",
        params: {
            event: "ed.apps.launch",
            to: "host",
            data: {
                action_type: "NATIVE_LAUNCH",
                appId
            }
        }
    });
    markSeen(device);
}

async function selectSource(device, source) {
    const sourceKey = source.toUpperCase().startsWith("KEY_") ? source.toUpperCase() : `KEY_${source.toUpperCase()}`;
    await sendKey(device, sourceKey);
}

async function tizenSendKey(device, key) {
    await tizenSend(device, {
        method: "ms.remote.control",
        params: {
            Cmd: "Click",
            DataOfCmd: key,
            Option: "false",
            TypeOfRemote: "SendRemoteKey"
        }
    });
}

async function tizenSend(device, payload) {
    const token = getTizenToken(device.id);
    const urlCandidates = buildTizenWsCandidates(device, token);
    let lastError;
    for (const url of urlCandidates) {
        try {
            await tizenWsRequest(url, payload);
            return;
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError || new Error("Tizen WS failed");
}

function buildTizenWsCandidates(device, token) {
    const nameBase64 = Buffer.from("ioBroker").toString("base64");
    const candidates = [];
    const add = (protocol, port) => {
        let url = `${protocol}://${device.ip}:${port}/api/v2/channels/samsung.remote.control?name=${nameBase64}`;
        if (token) url += `&token=${token}`;
        candidates.push(url);
    };

    if (device.protocol && device.port) {
        add(device.protocol, device.port);
    } else {
        add("wss", 8002);
        add("ws", 8001);
    }
    return candidates;
}

async function tizenWsRequest(url, payload) {
    return new Promise((resolve, reject) => {
        const safeUrl = url.replace(/token=[^&]+/i, "token=***");
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        let timeout = setTimeout(() => {
            ws.terminate();
            reject(new Error("WebSocket timeout"));
        }, WS_CONNECT_TIMEOUT);

        ws.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        ws.on("message", (data) => {
            let message;
            try {
                message = JSON.parse(data.toString());
            } catch (e) {
                return;
            }
            if (message.event === "ms.channel.connect") {
                setTimeout(() => {
                    try {
                        ws.send(JSON.stringify(payload));
                    } catch (e) {
                        clearTimeout(timeout);
                        ws.close();
                        return reject(e);
                    }
                    setTimeout(() => {
                        clearTimeout(timeout);
                        ws.close();
                        resolve();
                    }, WS_SEND_DELAY);
                }, WS_SEND_DELAY);
            }
        });

        ws.on("open", () => {
            adapter.log.debug(`WS connected: ${safeUrl}`);
        });
    });
}

async function pairTizen(device) {
    const nameBase64 = Buffer.from("ioBroker").toString("base64");
    const urls = [
        { url: `wss://${device.ip}:8002/api/v2/channels/samsung.remote.control?name=${nameBase64}`, secure: true },
        { url: `ws://${device.ip}:8001/api/v2/channels/samsung.remote.control?name=${nameBase64}`, secure: false }
    ];

    let lastError;
    for (const candidate of urls) {
        try {
            const token = await pairTizenWithUrl(candidate.url, candidate.secure);
            return token;
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError || new Error("Pairing failed");
}

async function pairTizenWithUrl(url, secure) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, secure ? { rejectUnauthorized: false } : undefined);
        let timeout = setTimeout(() => {
            ws.terminate();
            reject(new Error("Pairing timeout"));
        }, WS_CONNECT_TIMEOUT * 2);

        ws.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        ws.on("message", (data) => {
            let message;
            try {
                message = JSON.parse(data.toString());
            } catch (e) {
                return;
            }
            if (message.event === "ms.channel.connect") {
                clearTimeout(timeout);
                const token = message?.data?.token || message?.data?.data?.token || "";
                ws.close();
                if (!token) return reject(new Error("No token received"));
                resolve(token);
            }
        });
    });
}

async function pairHj(device, pin) {
    if (!pin) throw new Error("Missing PIN");
    const tv = new SamsungHJ({ ...HJ_DEVICE_CONFIG, ip: device.ip });
    await tv.init2();
    await tv.requestPin();
    const identity = await tv.confirmPin(pin);
    return identity;
}

async function onMessage(obj) {
    if (!obj || !obj.command) return;

    if (obj.command === "discover") {
        const timeout = (obj.message && obj.message.timeout) || adapter.config.discoveryTimeout || 5;
        try {
            const result = await performDiscovery(false, timeout);
            adapter.sendTo(obj.from, obj.command, { ok: true, devices: result, lastScan: lastDiscovery }, obj.callback);
        } catch (e) {
            adapter.sendTo(obj.from, obj.command, { ok: false, error: e.message }, obj.callback);
        }
        return;
    }

    if (obj.command === "getDiscovered") {
        const devices = Array.from(discoveredByIp.values());
        adapter.sendTo(obj.from, obj.command, { ok: true, devices, lastScan: lastDiscovery }, obj.callback);
        return;
    }

    if (obj.command === "pair") {
        const deviceId = obj.message && obj.message.id;
        const pin = obj.message && obj.message.pin;
        let device = devicesById.get(deviceId);
        if (!device && obj.message && obj.message.device) {
            const d = obj.message.device;
            const id = normalizeId(d.id || d.uuid || d.usn || deviceId || d.ip || "");
            device = {
                id,
                name: d.name || `tv-${id.slice(0, 6)}`,
                displayName: d.displayName || d.name || d.model || "",
                ip: d.ip || "",
                mac: d.mac || "",
                model: d.model || "",
                api: d.api || "tizen",
                protocol: d.protocol || "",
                port: d.port || 0,
                uuid: d.uuid || "",
                source: d.source || "pair"
            };
            if (device.ip) {
                discoveredByIp.set(device.ip, device);
            }
        }
        if (!device) {
            adapter.sendTo(obj.from, obj.command, { ok: false, error: "Unknown device" }, obj.callback);
            return;
        }
        try {
            if (device.api === "hj") {
                const identity = await pairHj(device, pin);
                setInMemoryHjIdentity(device.id, identity);
                await adapter.setStateAsync(`${device.name}.info.paired`, true, true);
                adapter.sendTo(obj.from, obj.command, { ok: true, identity }, obj.callback);
            } else {
                const token = await pairTizen(device);
                setInMemoryToken(device.id, token);
                await adapter.setStateAsync(`${device.name}.info.paired`, true, true);
                adapter.sendTo(obj.from, obj.command, { ok: true, token }, obj.callback);
            }
        } catch (e) {
            adapter.sendTo(obj.from, obj.command, { ok: false, error: e.message }, obj.callback);
        }
        return;
    }
}

async function performDiscovery(updateKnownDevices, timeoutOverride) {
    const timeout = Math.max(2, parseInt(timeoutOverride || adapter.config.discoveryTimeout, 10) || 5) * 1000;
    const discovered = [];

    if (adapter.config.enableSsdp) {
        const ssdp = await discoverSsdp(timeout);
        discovered.push(...ssdp);
    }

    if (adapter.config.enableMdns) {
        const mdns = await discoverMdns(timeout);
        discovered.push(...mdns);
    }

    const byIp = new Map();
    for (const entry of discovered) {
        if (!entry.ip) continue;
        const existing = byIp.get(entry.ip) || { ip: entry.ip, source: [] };
        existing.source = Array.from(new Set([...(existing.source || []), ...(entry.source || [])]));
        byIp.set(entry.ip, { ...existing, ...entry });
    }

    const results = [];
    for (const entry of byIp.values()) {
        const info = await probeDevice(entry.ip, entry);
        if (info) {
            results.push(info);
            discoveredByIp.set(entry.ip, info);

            if (updateKnownDevices) {
                const macKey = normalizeMac(info.mac || "");
                const match = devicesById.get(info.id) || (macKey ? devicesByMac.get(macKey) : null);
                if (match) {
                    if (info.ip && match.ip !== info.ip) {
                        match.ip = info.ip;
                    }
                    if (info.mac && !match.mac) {
                        match.mac = macKey;
                        devicesByMac.set(match.mac, match);
                    }
                    if (info.model && !match.model) match.model = info.model;
                    match.api = info.api || match.api;
                    match.protocol = info.protocol || match.protocol;
                    match.port = info.port || match.port;
                    await updateDeviceInfoStates(match);
                }
            }
        }
    }

    lastDiscovery = Date.now();
    return results;
}

async function discoverSsdp(timeoutMs) {
    return new Promise((resolve) => {
        const results = [];
        const client = new SsdpClient();
        client.on("response", (headers, statusCode, rinfo) => {
            const server = headers.SERVER || headers.Server || headers.server || "";
            const st = headers.ST || headers.St || headers.st || "";
            const usn = headers.USN || headers.Usn || headers.usn || "";
            const location = headers.LOCATION || headers.Location || headers.location || "";
            if (!/samsung/i.test(`${server} ${st} ${usn}`)) return;

            results.push({
                ip: rinfo.address,
                usn,
                location,
                st,
                server,
                source: ["ssdp"]
            });
        });
        client.search("ssdp:all");
        setTimeout(() => {
            client.stop();
            resolve(results);
        }, timeoutMs);
    });
}

async function discoverMdns(timeoutMs) {
    const services = (adapter.config.mdnsServices || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/^_/, ""));

    if (!services.length) return [];

    const bonjour = new Bonjour();
    const results = new Map();
    const browsers = [];

    for (const svc of services) {
        const [type] = svc.split(".");
        const browser = bonjour.find({ type, protocol: "tcp" }, (service) => {
            const name = (service.name || "").toLowerCase();
            const txt = service.txt || {};
            const manufacturer = (txt.manufacturer || txt.mf || "").toLowerCase();
            if (!name.includes("samsung") && !manufacturer.includes("samsung") && !svc.includes("samsung")) {
                return;
            }
            const addresses = Array.isArray(service.addresses) ? service.addresses : [];
            for (const ip of addresses) {
                if (!ip || ip.includes(":")) continue; // ignore IPv6 for now
                results.set(ip, { ip, name: service.name, source: ["mdns"], mdns: svc });
            }
        });
        browsers.push(browser);
    }

    return new Promise((resolve) => {
        setTimeout(() => {
            for (const browser of browsers) {
                try {
                    browser.stop();
                } catch (e) {
                    // ignore
                }
            }
            bonjour.destroy();
            resolve(Array.from(results.values()));
        }, timeoutMs);
    });
}

async function probeDevice(ip, seed) {
    const result = {
        ip,
        source: seed.source || [],
        name: seed.name || "",
        model: "",
        api: "unknown",
        protocol: "",
        port: 0,
        uuid: "",
        id: "",
        mac: ""
    };

    // try tizen https
    const tizenSecure = await fetchTizenInfo(ip, "wss", 8002, 2000);
    if (tizenSecure) {
        result.api = "tizen";
        result.protocol = "wss";
        result.port = 8002;
        applyTizenInfo(result, tizenSecure);
    }

    // try tizen http if not found
    if (result.api !== "tizen") {
        const tizen = await fetchTizenInfo(ip, "ws", 8001, 2000);
        if (tizen) {
            result.api = "tizen";
            result.protocol = "ws";
            result.port = 8001;
            applyTizenInfo(result, tizen);
        }
    }

    // try HJ info
    if (result.api === "unknown") {
        const hj = await fetchHjInfo(ip, 2000);
        if (hj) {
            result.api = "hj";
            result.port = 8000;
            result.protocol = "ws";
            result.id = normalizeId(hj.DeviceID || "");
            result.name = result.name || hj.DeviceName || "";
        }
    }

    // try UPnP description
    if (seed.location) {
        const desc = await fetchUpnpDescription(seed.location, 2000);
        if (desc) {
            if (!result.model) result.model = desc.modelName || "";
            if (!result.name) result.name = desc.friendlyName || "";
            if (!result.uuid && desc.UDN) result.uuid = desc.UDN;
        }
    }

    if (!result.id) {
        result.id = normalizeId(result.uuid || seed.usn || seed.st || seed.ip || "");
    }

    if (!result.name) {
        result.name = `tv-${result.id.slice(0, 6)}`;
    }

    const mac = await getMacForIp(ip);
    if (mac) result.mac = mac;
    if (mac && (!result.id || looksLikeIp(result.id))) {
        result.id = mac;
    }

    return result.id ? result : null;
}

function applyTizenInfo(result, info) {
    const device = info.device || info || {};
    result.name = result.name || device.name || info.name || "";
    result.model = device.modelName || device.model || result.model || "";
    result.uuid = device.id || device.udn || device.uuid || result.uuid || "";
    result.id = normalizeId(device.id || device.udn || device.uuid || info.id || result.id || "");
    result.mac = normalizeMac(device.wifiMac || device.mac || result.mac || "");
}

async function fetchTizenInfo(ip, protocol, port, timeoutMs) {
    const url = `${protocol === "wss" ? "https" : "http"}://${ip}:${port}/api/v2/`;
    try {
        const res = await fetchWithTimeout(url, timeoutMs, { agent: protocol === "wss" ? httpsAgent : undefined });
        if (!res) return null;
        return res;
    } catch (e) {
        return null;
    }
}

async function fetchHjInfo(ip, timeoutMs) {
    const url = `http://${ip}:8001/ms/1.0/`;
    try {
        const res = await fetchWithTimeout(url, timeoutMs);
        if (!res) return null;
        return res;
    } catch (e) {
        return null;
    }
}

async function fetchUpnpDescription(url, timeoutMs) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!resp.ok) return null;
        const text = await resp.text();
        const xml = xmlParser.parse(text);
        const device = xml?.root?.device || xml?.device || {};
        return {
            friendlyName: device.friendlyName,
            manufacturer: device.manufacturer,
            modelName: device.modelName,
            UDN: normalizeId(device.UDN || "")
        };
    } catch (e) {
        return null;
    }
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { ...options, signal: controller.signal });
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function checkPort(ip, port, timeoutMs) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs);
        socket.once("error", () => finish(false));
        socket.once("timeout", () => finish(false));
        socket.connect(port, ip, () => finish(true));
    });
}

async function getMacForIp(ip) {
    if (!ip) return "";
    try {
        const { exec } = require("child_process");
        return await new Promise((resolve) => {
            exec(`ip neigh show ${ip}`, (err, stdout) => {
                if (!err && stdout) {
                    const match = stdout.match(/lladdr\s+([0-9a-f:]{17})/i);
                    if (match) return resolve(normalizeMac(match[1]));
                }
                exec(`arp -n ${ip}`, (err2, stdout2) => {
                    if (!err2 && stdout2) {
                        const match2 = stdout2.match(/([0-9a-f:]{17})/i);
                        if (match2) return resolve(normalizeMac(match2[1]));
                    }
                    resolve("");
                });
            });
        });
    } catch (e) {
        return "";
    }
}

function looksLikeIp(value) {
    if (!value || typeof value !== "string") return false;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(value.trim());
}

let arpCache = { ts: 0, map: new Map() };

async function refreshIpFromMac(device) {
    if (!device || !device.mac) return false;
    const mac = normalizeMac(device.mac);
    const ip = await getIpForMac(mac);
    if (ip && ip !== device.ip) {
        device.ip = ip;
        await updateDeviceInfoStates(device);
        adapter.log.info(`IP updated for ${device.name} via MAC ${mac}: ${ip}`);
        return true;
    }
    return false;
}

async function getIpForMac(mac) {
    if (!mac) return "";
    const table = await getArpTable();
    return table.get(normalizeMac(mac)) || "";
}

async function getArpTable() {
    const now = Date.now();
    if (now - arpCache.ts < 10000 && arpCache.map.size) return arpCache.map;

    const map = new Map();
    try {
        const { exec } = require("child_process");
        await new Promise((resolve) => {
            exec("ip neigh", (err, stdout) => {
                if (!err && stdout) {
                    const lines = stdout.split("\n");
                    for (const line of lines) {
                        const match = line.match(/^([0-9.]+)\s+.*lladdr\s+([0-9a-f:]{17})/i);
                        if (match) {
                            map.set(normalizeMac(match[2]), match[1]);
                        }
                    }
                }
                resolve();
            });
        });
    } catch (e) {
        // ignore
    }

    if (map.size === 0) {
        try {
            const { exec } = require("child_process");
            await new Promise((resolve) => {
                exec("arp -an", (err, stdout) => {
                    if (!err && stdout) {
                        const lines = stdout.split("\n");
                        for (const line of lines) {
                            const match = line.match(/\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-f:]{17})/i);
                            if (match) {
                                map.set(normalizeMac(match[2]), match[1]);
                            }
                        }
                    }
                    resolve();
                });
            });
        } catch (e) {
            // ignore
        }
    }

    arpCache = { ts: now, map };
    return map;
}

adapter = createAdapter();
