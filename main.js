'use strict';

const utils = require('@iobroker/adapter-core');
const { Client: SsdpClient } = require('node-ssdp');
const { Bonjour } = require('bonjour-service');
const WebSocket = require('ws');
const wol = require('wake_on_lan');
const fetch = require('node-fetch');
const https = require('https');
const net = require('net');
const { execFile } = require('child_process');
const { XMLParser } = require('fast-xml-parser');
const LegacyRemote = require('./lib/legacy/LegacyRemote');
const SamsungHJ = require('./lib/hj/SamsungTv');

const HJ_DEVICE_CONFIG = {
    appId: '721b6fce-4ee6-48ba-8045-955a539edadb',
    userId: '654321',
};

const WS_CONNECT_TIMEOUT = 5000;
const WS_SEND_DELAY = 200;
const PAIRING_TIMEOUT = 20000;
const HJ_INFO_TIMEOUT = 4000;
const NO_TOKEN = '__no_token__';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const xmlParser = new XMLParser({ ignoreAttributes: false });

let adapter;

let devicesById = new Map();
let devicesByName = new Map();
let devicesByMac = new Map();
let discoveredByIp = new Map();
let tokens = { tizen: {}, hj: {} };
let lastDiscovery = 0;
let pingUnavailable = false;

let pollTimer;
let scanTimer;
let configSaveTimer;

function createAdapter() {
    return new utils.Adapter({
        name: 'samsungtv',
        ready: main,
        stateChange: onStateChange,
        message: onMessage,
        unload: onUnload,
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
        if (configSaveTimer) {
            clearTimeout(configSaveTimer);
            configSaveTimer = null;
        }
        callback();
    } catch (e) {
        callback();
    }
}

function sanitizeName(name) {
    if (!name || typeof name !== 'string') {
        return '';
    }
    const cleaned = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '')
        .replace(/--+/g, '-');
    return cleaned;
}

function ensureUniqueName(desired, existingSet, fallbackBase) {
    let name = desired || fallbackBase || 'tv';
    if (!existingSet.has(name)) {
        return name;
    }
    let i = 2;
    while (existingSet.has(`${name}-${i}`)) {
        i++;
    }
    return `${name}-${i}`;
}

function normalizeId(id) {
    if (!id || typeof id !== 'string') {
        return '';
    }
    return id
        .replace(/^uuid:/i, '')
        .replace(/^urn:uuid:/i, '')
        .trim();
}

function normalizeMac(mac) {
    if (!mac || typeof mac !== 'string') {
        return '';
    }
    return mac.trim().toLowerCase();
}

function normalizeDeviceId(id) {
    const norm = normalizeId(id);
    if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(norm)) {
        return normalizeMac(norm);
    }
    return norm;
}

function loadTokensFromConfig() {
    tokens = { tizen: {}, hj: {} };
    if (!adapter.config.tokens) {
        return;
    }
    if (typeof adapter.config.tokens !== 'string') {
        return;
    }
    try {
        const parsed = JSON.parse(adapter.config.tokens);
        if (parsed && typeof parsed === 'object') {
            tokens.tizen = parsed.tizen || {};
            tokens.hj = parsed.hj || {};
        }
    } catch (e) {
        adapter.log.warn('Could not parse encrypted tokens from config.');
    }
}

async function migrateLegacyConfigFromSamsung() {
    if (adapter.name === 'samsung') {
        return false;
    }
    if (adapter.config && adapter.config.migratedFromSamsung) {
        return false;
    }

    const hasDevices = Array.isArray(adapter.config.devices) && adapter.config.devices.length > 0;
    if (hasDevices) {
        return false;
    }

    let legacy;
    try {
        legacy = await adapter.getForeignObjectAsync('system.adapter.samsung.0');
    } catch (e) {
        legacy = null;
    }
    if (!legacy || !legacy.native) {
        return false;
    }

    const merged = { ...adapter.config, ...legacy.native, migratedFromSamsung: true };
    try {
        await adapter.extendForeignObjectAsync(`system.adapter.${adapter.namespace}`, { native: merged });
        adapter.config = merged;
        adapter.log.info('Imported configuration from legacy samsung.0 adapter.');
        return true;
    } catch (e) {
        adapter.log.warn(`Could not import legacy samsung.0 config: ${e.message}`);
        return false;
    }
}

function getTizenToken(deviceId) {
    const token = (tokens.tizen && tokens.tizen[deviceId]) || '';
    return token === NO_TOKEN ? '' : token;
}

function getHjIdentity(deviceId) {
    return (tokens.hj && tokens.hj[deviceId]) || null;
}

function setInMemoryToken(deviceId, tokenValue) {
    if (!tokens.tizen) {
        tokens.tizen = {};
    }
    tokens.tizen[deviceId] = tokenValue;
    persistTokens();
}

function setInMemoryHjIdentity(deviceId, identity) {
    if (!tokens.hj) {
        tokens.hj = {};
    }
    tokens.hj[deviceId] = identity;
    persistTokens();
}

function persistTokens() {
    try {
        adapter.config.tokens = JSON.stringify(tokens);
        scheduleConfigSave();
    } catch (e) {
        adapter.log.warn(`Failed to persist tokens: ${e.message}`);
    }
}

function getConfiguredDevices() {
    const list = Array.isArray(adapter.config.devices) ? adapter.config.devices : [];
    const existingNames = new Set();
    const result = [];

    for (const raw of list) {
        if (!raw || typeof raw !== 'object') {
            continue;
        }
        const rawMac = normalizeMac(raw.mac || '');
        let id = normalizeId(raw.id || raw.uuid || raw.usn || '');
        if ((!id || looksLikeIp(id)) && rawMac) {
            id = rawMac;
        }
        if (!id) {
            id = normalizeId(raw.ip || '');
        }
        id = normalizeDeviceId(id);
        if (!id) {
            adapter.log.warn('Skipping device without stable id in config.');
            continue;
        }
        const rawName = raw.name || raw.friendlyName || raw.model || 'tv';
        const safeName = ensureUniqueName(
            sanitizeName(rawName) || `tv-${id.slice(0, 6)}`,
            existingNames,
            `tv-${id.slice(0, 6)}`,
        );
        existingNames.add(safeName);

        const device = {
            id,
            name: safeName,
            displayName: rawName,
            ip: raw.ip || '',
            mac: normalizeMac(raw.mac || ''),
            model: raw.model || '',
            api: raw.api || 'unknown',
            protocol: raw.protocol || '',
            port: raw.port || 0,
            uuid: raw.uuid || '',
            source: raw.source || 'config',
            tokenAuthSupport: typeof raw.tokenAuthSupport === 'boolean' ? raw.tokenAuthSupport : undefined,
            remoteAvailable: typeof raw.remoteAvailable === 'boolean' ? raw.remoteAvailable : undefined,
            hjAvailable: typeof raw.hjAvailable === 'boolean' ? raw.hjAvailable : undefined,
        };
        result.push(device);
    }
    return result;
}

function scheduleConfigSave() {
    if (configSaveTimer) {
        clearTimeout(configSaveTimer);
    }
    configSaveTimer = setTimeout(async () => {
        configSaveTimer = null;
        try {
            await adapter.extendForeignObjectAsync(`system.adapter.${adapter.namespace}`, { native: adapter.config });
            adapter.log.debug('Persisted updated device config.');
        } catch (e) {
            adapter.log.warn(`Failed to persist device config: ${e.message}`);
        }
    }, 1500);
}

function updateConfigDeviceFromDiscovery(match, info) {
    if (!adapter.config) {
        return;
    }
    const list = Array.isArray(adapter.config.devices) ? adapter.config.devices : [];
    if (!list.length) {
        return;
    }

    let updated = false;
    const infoId = normalizeDeviceId(info.id || '');
    const infoMac = normalizeMac(info.mac || '');
    const infoIp = info.ip || '';

    for (const dev of list) {
        if (!dev || typeof dev !== 'object') {
            continue;
        }
        const devId = normalizeDeviceId(normalizeId(dev.id || dev.uuid || dev.usn || dev.ip || dev.mac || ''));
        const devMac = normalizeMac(dev.mac || '');
        const devIp = dev.ip || '';
        const isMatch =
            (infoId && devId && infoId === devId) ||
            (infoMac && devMac && infoMac === devMac) ||
            (!infoId && !infoMac && infoIp && devIp && infoIp === devIp) ||
            (match && match.id && devId && match.id === devId);
        if (!isMatch) {
            continue;
        }

        if (info.ip && dev.ip !== info.ip) {
            dev.ip = info.ip;
            updated = true;
        }
        if (info.mac && !dev.mac) {
            dev.mac = info.mac;
            updated = true;
        }
        if (info.api && dev.api !== info.api) {
            dev.api = info.api;
            updated = true;
        }
        if (info.protocol && dev.protocol !== info.protocol) {
            dev.protocol = info.protocol;
            updated = true;
        }
        if (info.port && dev.port !== info.port) {
            dev.port = info.port;
            updated = true;
        }
        if (typeof info.hjAvailable === 'boolean' && dev.hjAvailable !== info.hjAvailable) {
            dev.hjAvailable = info.hjAvailable;
            updated = true;
        }
        if (typeof info.tokenAuthSupport === 'boolean' && dev.tokenAuthSupport !== info.tokenAuthSupport) {
            dev.tokenAuthSupport = info.tokenAuthSupport;
            updated = true;
        }
        if (typeof info.remoteAvailable === 'boolean' && dev.remoteAvailable !== info.remoteAvailable) {
            dev.remoteAvailable = info.remoteAvailable;
            updated = true;
        }
    }

    if (updated) {
        scheduleConfigSave();
    }
}

async function checkLegacyObjects() {
    const namespaces = [adapter.namespace];
    if (adapter.name !== 'samsung') {
        namespaces.push('samsung.0');
    }
    const legacyIds = [];
    for (const ns of namespaces) {
        legacyIds.push(`${ns}.Power`, `${ns}.command`, `${ns}.control`, `${ns}.apps`, `${ns}.config`);
    }
    try {
        const found = [];
        for (const id of legacyIds) {
            const obj = await adapter.getForeignObjectAsync(id);
            if (obj) {
                found.push(id);
            }
        }
        if (found.length) {
            adapter.log.warn(
                `Legacy Samsung adapter objects detected in the same namespace. ` +
                    `Please remove or migrate old objects to avoid conflicts. Found: ${found.join(', ')}`,
            );
        }
        if (adapter.name !== 'samsung') {
            try {
                const legacyInstance = await adapter.getForeignObjectAsync('system.adapter.samsung.0');
                if (legacyInstance) {
                    adapter.log.info(
                        'Legacy adapter instance samsung.0 detected. Disable/remove it after migration to avoid confusion.',
                    );
                }
            } catch (e) {
                // ignore
            }
        }
    } catch (e) {
        // ignore
    }
}

async function reconcileDeviceObjects(devices) {
    const startKey = `${adapter.namespace}.`;
    const endKey = `${adapter.namespace}.\u9999`;
    let view;
    try {
        view = await adapter.getObjectViewAsync('system', 'device', { startkey: startKey, endkey: endKey });
    } catch (e) {
        view = null;
    }

    const deviceObjects = [];
    if (view && view.rows) {
        for (const row of view.rows) {
            if (row.value && row.value.type === 'device') {
                deviceObjects.push({ _id: row.id, obj: row.value });
            }
        }
    } else {
        try {
            const objs = await adapter.getForeignObjectsAsync(`${adapter.namespace}.*`);
            for (const id of Object.keys(objs)) {
                const obj = objs[id];
                if (obj && obj.type === 'device') {
                    deviceObjects.push({ _id: id, obj });
                }
            }
        } catch (e) {
            // ignore
        }
    }

    const byId = new Map(devices.map(d => [d.id, d]));
    const byName = new Map(devices.map(d => [d.name, d]));

    for (const entry of deviceObjects) {
        const objId = entry._id;
        const obj = entry.obj || {};
        const nativeId = obj.native && obj.native.deviceId ? normalizeDeviceId(obj.native.deviceId) : '';
        let match = null;
        if (nativeId && byId.has(nativeId)) {
            match = byId.get(nativeId);
        } else {
            const name = objId.startsWith(`${adapter.namespace}.`) ? objId.slice(adapter.namespace.length + 1) : '';
            if (name && byName.has(name)) {
                match = byName.get(name);
            }
        }

        if (match) {
            const desiredPrefix = `${adapter.namespace}.${match.name}`;
            if (!obj.native) {
                obj.native = {};
            }
            if (obj.native.deviceId !== match.id) {
                try {
                    obj.native.deviceId = match.id;
                    await adapter.setForeignObjectAsync(objId, { ...obj, _id: objId });
                } catch (e) {
                    adapter.log.warn(`Failed to update deviceId for ${objId}: ${e.message}`);
                }
            }
            if (objId !== desiredPrefix) {
                adapter.log.info(`Renaming device objects ${objId} -> ${desiredPrefix}`);
                await renamePrefix(objId, desiredPrefix);
            }
            continue;
        }

        adapter.log.info(`Removing stale device objects ${objId}`);
        await deletePrefix(objId);
    }
}

async function deletePrefix(prefix) {
    if (!prefix) {
        return;
    }
    try {
        await adapter.delForeignObjectAsync(prefix, { recursive: true });
        return;
    } catch (e) {
        // ignore, fallback below
    }
    let objs = {};
    try {
        objs = await adapter.getForeignObjectsAsync(`${prefix}.*`);
    } catch (e) {
        objs = {};
    }
    const allIds = Object.keys(objs);
    allIds.push(prefix);
    for (const oldId of allIds.sort((a, b) => b.length - a.length)) {
        try {
            await adapter.delForeignObjectAsync(oldId, { recursive: false });
        } catch (e) {
            // ignore
        }
    }
}

async function renamePrefix(oldPrefix, newPrefix) {
    if (!oldPrefix || !newPrefix || oldPrefix === newPrefix) {
        return;
    }
    const objs = await adapter.getForeignObjectsAsync(`${oldPrefix}.*`);
    const allIds = Object.keys(objs);
    allIds.push(oldPrefix); // include root device object

    // Create new objects first
    for (const oldId of allIds) {
        const obj = oldId === oldPrefix ? await adapter.getForeignObjectAsync(oldId) : objs[oldId];
        if (!obj) {
            continue;
        }
        const newId = oldId.replace(oldPrefix, newPrefix);
        const newObj = { ...obj, _id: newId };
        try {
            await adapter.setForeignObjectAsync(newId, newObj);
            if (obj.type === 'state') {
                const state = await adapter.getForeignStateAsync(oldId);
                if (state) {
                    await adapter.setForeignStateAsync(newId, state);
                }
            }
        } catch (e) {
            adapter.log.warn(`Failed to create renamed object ${newId}: ${e.message}`);
        }
    }

    // Delete old objects (recursive cleanup to avoid empty folders)
    await deletePrefix(oldPrefix);
}

async function ensureDeviceObjects(device) {
    const base = device.name;
    await adapter.setObjectNotExistsAsync(base, {
        type: 'device',
        common: { name: device.displayName || device.name },
        native: { deviceId: device.id },
    });

    await adapter.setObjectNotExistsAsync(`${base}.info`, {
        type: 'channel',
        common: { name: 'Info' },
        native: {},
    });

    await adapter.setObjectNotExistsAsync(`${base}.state`, {
        type: 'channel',
        common: { name: 'State' },
        native: {},
    });

    await adapter.setObjectNotExistsAsync(`${base}.control`, {
        type: 'channel',
        common: { name: 'Control' },
        native: {},
    });

    await ensureState(`${base}.info.id`, 'Stable ID', 'string', 'info.serial', device.id, true);
    await ensureState(`${base}.info.ip`, 'IP', 'string', 'info.ip', device.ip || '', true);
    await ensureState(`${base}.info.mac`, 'MAC', 'string', 'info.mac', device.mac || '', true);
    await ensureState(`${base}.info.model`, 'Model', 'string', 'info.name', device.model || '', true);
    await ensureState(`${base}.info.uuid`, 'UUID', 'string', 'info.uuid', device.uuid || '', true);
    await ensureState(`${base}.info.api`, 'API', 'string', 'info.name', device.api || '', true);
    await ensureState(`${base}.info.lastSeen`, 'Last Seen', 'number', 'value.time', 0, true);
    await ensureState(`${base}.info.paired`, 'Paired', 'boolean', 'indicator', false, true);
    await ensureState(`${base}.info.online`, 'Online', 'boolean', 'indicator.reachable', false, true);
    await ensureState(`${base}.info.tokenAuthSupport`, 'Token Auth Support', 'boolean', 'indicator', false, true);
    await ensureState(`${base}.info.remoteAvailable`, 'Remote Available', 'boolean', 'indicator', false, true);
    await ensureState(`${base}.info.hjAvailable`, 'HJ Available', 'boolean', 'indicator', false, true);

    await ensureState(`${base}.state.power`, 'Power', 'boolean', 'indicator.power', false, true);
    await ensureState(`${base}.state.volume`, 'Volume', 'number', 'value.volume', 0, true);
    await ensureState(`${base}.state.muted`, 'Muted', 'boolean', 'indicator.mute', false, true);
    await ensureState(`${base}.state.app`, 'App', 'string', 'text', '', true);
    await ensureState(`${base}.state.source`, 'Source', 'string', 'text', '', true);

    await ensureState(`${base}.control.power`, 'Power', 'boolean', 'switch', false, false);
    await ensureState(`${base}.control.wol`, 'Wake', 'boolean', 'button', false, false);
    await ensureState(`${base}.control.key`, 'Key', 'string', 'text', '', false);
    await ensureState(`${base}.control.volumeUp`, 'Volume Up', 'boolean', 'button', false, false);
    await ensureState(`${base}.control.volumeDown`, 'Volume Down', 'boolean', 'button', false, false);
    await ensureState(`${base}.control.mute`, 'Mute', 'boolean', 'button', false, false);
    await ensureState(`${base}.control.channelUp`, 'Channel Up', 'boolean', 'button', false, false);
    await ensureState(`${base}.control.channelDown`, 'Channel Down', 'boolean', 'button', false, false);
    await ensureState(`${base}.control.launchApp`, 'Launch App', 'string', 'text', '', false);
    await ensureState(`${base}.control.source`, 'Source', 'string', 'text', '', false);
}

async function ensureState(id, name, type, role, def, readOnly) {
    await adapter.setObjectNotExistsAsync(id, {
        type: 'state',
        common: {
            name,
            type,
            role,
            read: true,
            write: !readOnly,
            def,
        },
        native: {},
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
    await reconcileDeviceObjects(devices);

    devicesById = new Map();
    devicesByName = new Map();
    devicesByMac = new Map();
    for (const device of devices) {
        devicesById.set(device.id, device);
        devicesByName.set(device.name, device);
        if (device.mac) {
            devicesByMac.set(device.mac, device);
        }
    }

    for (const device of devices) {
        await ensureDeviceObjects(device);
        await updateDeviceInfoStates(device);
    }

    adapter.subscribeStates('*.control.*');

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
    await adapter.setStateAsync(`${base}.info.ip`, device.ip || '', true);
    await adapter.setStateAsync(`${base}.info.mac`, device.mac || '', true);
    await adapter.setStateAsync(`${base}.info.model`, device.model || '', true);
    await adapter.setStateAsync(`${base}.info.uuid`, device.uuid || '', true);
    await adapter.setStateAsync(`${base}.info.api`, device.api || '', true);
    await adapter.setStateAsync(`${base}.info.paired`, isDevicePaired(device), true);
    if (typeof device.tokenAuthSupport === 'boolean') {
        await adapter.setStateAsync(`${base}.info.tokenAuthSupport`, device.tokenAuthSupport, true);
    }
    if (typeof device.remoteAvailable === 'boolean') {
        await adapter.setStateAsync(`${base}.info.remoteAvailable`, device.remoteAvailable, true);
    }
    if (typeof device.hjAvailable === 'boolean') {
        await adapter.setStateAsync(`${base}.info.hjAvailable`, device.hjAvailable, true);
    }
}

function isDevicePaired(device) {
    if (device.api === 'tizen') {
        const token = (tokens.tizen && tokens.tizen[device.id]) || '';
        if (!token) {
            return false;
        }
        if (token === NO_TOKEN && device.tokenAuthSupport === true) {
            return false;
        }
        return true;
    }
    if (device.api === 'hj') {
        return !!getHjIdentity(device.id);
    }
    return false;
}

async function pollDevices() {
    for (const device of devicesById.values()) {
        await pollDevice(device);
    }
}

async function pollDevice(device) {
    try {
        const status = await checkDeviceStatus(device);
        await adapter.setStateAsync(`${device.name}.info.online`, status.online, true);
        await adapter.setStateAsync(`${device.name}.state.power`, status.power, true);
        await adapter.setStateAsync(`${device.name}.control.power`, status.power, true);
    } catch (e) {
        // ignore
    }
}

function scheduleDevicePoll(device, delayMs) {
    if (!device) {
        return;
    }
    const delay = Math.max(500, delayMs || 0);
    setTimeout(() => pollDevice(device), delay);
}

async function checkDeviceOnline(device) {
    const status = await checkDeviceStatus(device);
    return status.online;
}

function extractPowerState(info) {
    if (!info || typeof info !== 'object') {
        return '';
    }
    const device = info.device || info || {};
    const candidates = [
        device.PowerState,
        device.powerState,
        device.powerstate,
        info.PowerState,
        info.powerState,
        info.powerstate,
    ];
    for (const value of candidates) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim().toLowerCase();
        }
    }
    return '';
}

function interpretPowerState(value) {
    if (!value) {
        return null;
    }
    const v = value.toLowerCase();
    if (['on', 'active', 'wake', 'awake'].includes(v)) {
        return true;
    }
    if (['standby', 'off', 'inactive', 'sleep'].includes(v)) {
        return false;
    }
    return null;
}

async function checkDeviceStatus(device) {
    if (!device.ip) {
        await refreshIpFromMac(device);
        if (!device.ip) {
            return { online: false, power: false };
        }
    }

    let status = await checkDeviceStatusWithIp(device);
    if (!status.online && device.mac) {
        const updated = await refreshIpFromMac(device);
        if (updated) {
            status = await checkDeviceStatusWithIp(device);
        }
    }
    return status;
}

async function checkDeviceStatusWithIp(device) {
    if (!device.ip) {
        return { online: false, power: false };
    }

    if (device.api === 'tizen') {
        const info = await fetchTizenInfo(device.ip, device.protocol || 'wss', device.port || 8002, 1500);
        if (info) {
            const powerState = extractPowerState(info);
            const power = interpretPowerState(powerState);
            if (!device.mac) {
                const mac = normalizeMac(info?.device?.wifiMac || info?.device?.mac || '');
                if (mac) {
                    device.mac = mac;
                    devicesByMac.set(device.mac, device);
                    await updateDeviceInfoStates(device);
                }
            }
            markSeen(device);
            return { online: true, power: power === null ? true : power };
        }
        // fallback to 8001
        const info2 = await fetchTizenInfo(device.ip, 'ws', 8001, 1500);
        if (info2) {
            const powerState = extractPowerState(info2);
            const power = interpretPowerState(powerState);
            if (!device.mac) {
                const mac = normalizeMac(info2?.device?.wifiMac || info2?.device?.mac || '');
                if (mac) {
                    device.mac = mac;
                    devicesByMac.set(device.mac, device);
                    await updateDeviceInfoStates(device);
                }
            }
            markSeen(device);
            return { online: true, power: power === null ? true : power };
        }
    } else if (device.api === 'hj') {
        const info = await fetchHjInfo(device.ip, 1500);
        if (info) {
            const powerState = extractPowerState(info);
            const power = interpretPowerState(powerState);
            markSeen(device);
            return { online: true, power: power === null ? true : power };
        }
        const pingOk = await pingHost(device.ip, 1200);
        if (pingOk === true) {
            markSeen(device);
            return { online: true, power: false };
        }
        const ok = await checkPort(device.ip, 8000, 1000);
        if (ok) {
            markSeen(device);
            return { online: true, power: false };
        }
    } else if (device.api === 'legacy') {
        const ok = await checkPort(device.ip, 55000, 1500);
        if (ok) {
            markSeen(device);
            return { online: true, power: true };
        }
    }

    // generic fallback: ping port 8001
    const okGeneric = await checkPort(device.ip, 8001, 1000);
    if (okGeneric) {
        markSeen(device);
        return { online: true, power: true };
    }
    return { online: false, power: false };
}

function markSeen(device) {
    const ts = Date.now();
    adapter.setState(`${device.name}.info.lastSeen`, ts, true);
}

function onStateChange(id, state) {
    if (!state || state.ack) {
        return;
    }
    const parts = id.split('.');
    if (parts.length < 5) {
        return;
    }
    if (`${parts[0]}.${parts[1]}` !== adapter.namespace) {
        return;
    }

    const deviceName = parts[2];
    const channel = parts[3];
    const command = parts[4];

    if (channel !== 'control') {
        return;
    }

    const device = devicesByName.get(deviceName);
    if (!device) {
        adapter.log.warn(`Unknown device for stateChange: ${deviceName}`);
        return;
    }

    handleControl(device, id, command, state.val).catch(e => {
        adapter.log.warn(`Failed to execute ${command} for ${device.name}: ${e.message}`);
    });
}

async function handleControl(device, id, command, value) {
    switch (command) {
        case 'power':
            await setPower(device, !!value);
            await adapter.setStateAsync(id, !!value, true);
            await adapter.setStateAsync(`${device.name}.state.power`, !!value, true);
            return;
        case 'wol':
            if (adapter.config.enableWol && device.mac) {
                wol.wake(device.mac);
                await adapter.setStateAsync(id, false, true);
            }
            return;
        case 'key':
            if (typeof value === 'string' && value.trim()) {
                const key = normalizeKeyInput(value);
                if (key) {
                    await sendKey(device, key);
                }
                await adapter.setStateAsync(id, '', true);
            }
            return;
        case 'volumeUp':
            return sendButton(device, id, 'KEY_VOLUP', value);
        case 'volumeDown':
            return sendButton(device, id, 'KEY_VOLDOWN', value);
        case 'mute':
            return sendButton(device, id, 'KEY_MUTE', value);
        case 'channelUp':
            return sendButton(device, id, 'KEY_CHUP', value);
        case 'channelDown':
            return sendButton(device, id, 'KEY_CHDOWN', value);
        case 'launchApp':
            if (typeof value === 'string' && value.trim()) {
                await launchApp(device, value.trim());
                await adapter.setStateAsync(id, '', true);
            }
            return;
        case 'source':
            if (typeof value === 'string' && value.trim()) {
                await selectSource(device, value.trim());
                await adapter.setStateAsync(id, '', true);
            }
            return;
        default:
            return;
    }
}

async function sendButton(device, id, key, value) {
    if (!key) {
        return;
    }
    if (isTruthyValue(value)) {
        await sendKey(device, key);
        await adapter.setStateAsync(id, false, true);
    }
}

function isTruthyValue(val) {
    return val === true || val === 1 || val === 'true';
}

function normalizeKeyInput(input) {
    if (!input || typeof input !== 'string') {
        return '';
    }
    const raw = input.trim();
    if (!raw) {
        return '';
    }
    const upper = raw.toUpperCase();
    if (upper.startsWith('KEY_')) {
        return upper;
    }

    const normalized = raw.toLowerCase().replace(/\s+/g, '');
    const map = {
        up: 'KEY_UP',
        arrowup: 'KEY_UP',
        down: 'KEY_DOWN',
        arrowdown: 'KEY_DOWN',
        left: 'KEY_LEFT',
        arrowleft: 'KEY_LEFT',
        right: 'KEY_RIGHT',
        arrowright: 'KEY_RIGHT',
        enter: 'KEY_ENTER',
        ok: 'KEY_ENTER',
        back: 'KEY_RETURN',
        return: 'KEY_RETURN',
        home: 'KEY_HOME',
        source: 'KEY_SOURCE',
        menu: 'KEY_MENU',
        info: 'KEY_INFO',
        guide: 'KEY_GUIDE',
        exit: 'KEY_EXIT',
        volup: 'KEY_VOLUP',
        volumeup: 'KEY_VOLUP',
        voldown: 'KEY_VOLDOWN',
        volumedown: 'KEY_VOLDOWN',
        mute: 'KEY_MUTE',
        chup: 'KEY_CHUP',
        channelup: 'KEY_CHUP',
        chdown: 'KEY_CHDOWN',
        channeldown: 'KEY_CHDOWN',
        play: 'KEY_PLAY',
        pause: 'KEY_PAUSE',
        stop: 'KEY_STOP',
        rewind: 'KEY_REWIND',
        ff: 'KEY_FF',
        fastforward: 'KEY_FF',
        record: 'KEY_REC',
        red: 'KEY_RED',
        green: 'KEY_GREEN',
        yellow: 'KEY_YELLOW',
        blue: 'KEY_BLUE',
        0: 'KEY_0',
        1: 'KEY_1',
        2: 'KEY_2',
        3: 'KEY_3',
        4: 'KEY_4',
        5: 'KEY_5',
        6: 'KEY_6',
        7: 'KEY_7',
        8: 'KEY_8',
        9: 'KEY_9',
    };

    return map[normalized] || upper;
}

async function setPower(device, on) {
    const status = await checkDeviceStatus(device);
    adapter.log.debug(
        `Power request for ${device.name}: target=${on} api=${device.api} online=${status.online} power=${status.power}`,
    );
    if (on) {
        if (status.power) {
            return;
        }
        if (device.api === 'hj') {
            if (adapter.config.enableWol && device.mac) {
                wol.wake(device.mac);
                scheduleDevicePoll(device, 6000);
                schedulePowerFallback(device, true, 'KEY_POWER', 8000);
                return;
            }
            if (status.online) {
                try {
                    await sendKey(device, 'KEY_POWERON');
                    scheduleDevicePoll(device, 4000);
                    schedulePowerFallback(device, true, 'KEY_POWER', 6000);
                    return;
                } catch (e) {
                    try {
                        await sendKey(device, 'KEY_POWER');
                        scheduleDevicePoll(device, 4000);
                        return;
                    } catch (e2) {
                        // fallback to WOL
                    }
                }
            }
        } else {
            if (status.online) {
                try {
                    await sendKey(device, 'KEY_POWER');
                    scheduleDevicePoll(device, 4000);
                    return;
                } catch (e) {
                    // fallback to WOL
                }
            }
        }
        if (adapter.config.enableWol && device.mac) {
            wol.wake(device.mac);
        }
        scheduleDevicePoll(device, 6000);
        return;
    }
    if (status.power) {
        if (device.api === 'hj') {
            try {
                await sendKey(device, 'KEY_POWER');
                scheduleDevicePoll(device, 3000);
                schedulePowerFallback(device, false, 'KEY_POWEROFF', 5000);
                return;
            } catch (e) {
                await sendKey(device, 'KEY_POWER');
                scheduleDevicePoll(device, 3000);
                return;
            }
        }
        await sendKey(device, 'KEY_POWER');
        scheduleDevicePoll(device, 3000);
    }
}

function schedulePowerFallback(device, targetOn, fallbackKey, delayMs) {
    if (!device) {
        return;
    }
    const delay = Math.max(1000, delayMs || 0);
    setTimeout(async () => {
        try {
            const status = await checkDeviceStatus(device);
            if (targetOn && status.power) {
                return;
            }
            if (!targetOn && !status.power) {
                return;
            }
            if (!status.online) {
                return;
            }
            adapter.log.debug(`Power fallback for ${device.name}: key=${fallbackKey}`);
            await sendKey(device, fallbackKey);
            scheduleDevicePoll(device, 3000);
        } catch (e) {
            // ignore
        }
    }, delay);
}

async function sendKey(device, key) {
    if (device.api === 'tizen') {
        try {
            await tizenSendKey(device, key);
            markSeen(device);
            return;
        } catch (e) {
            if (isTizenRemoteUnsupported(e)) {
                const hjOk = device.hjAvailable === true || (await checkPort(device.ip, 8000, 1500));
                if (hjOk) {
                    device.hjAvailable = true;
                    device.api = 'hj';
                    adapter.log.warn(`Tizen remote unsupported for ${device.name}, switching to HJ`);
                    await updateDeviceInfoStates(device);
                    updateConfigDeviceFromDiscovery(device, {
                        id: device.id,
                        ip: device.ip,
                        mac: device.mac,
                        api: 'hj',
                        hjAvailable: true,
                    });
                    await hjSendKey(device, key);
                    markSeen(device);
                    return;
                }
            }
            throw e;
        }
    } else if (device.api === 'hj') {
        await hjSendKey(device, key);
    } else if (device.api === 'legacy') {
        await legacySendKey(device, key);
    } else {
        // try tizen first
        try {
            await tizenSendKey(device, key);
        } catch (e) {
            if (isTizenRemoteUnsupported(e)) {
                const hjOk = await checkPort(device.ip, 8000, 1500);
                if (hjOk) {
                    device.hjAvailable = true;
                    device.api = 'hj';
                    adapter.log.warn(`Tizen remote unsupported for ${device.name}, switching to HJ`);
                    await updateDeviceInfoStates(device);
                    updateConfigDeviceFromDiscovery(device, {
                        id: device.id,
                        ip: device.ip,
                        mac: device.mac,
                        api: 'hj',
                        hjAvailable: true,
                    });
                    await hjSendKey(device, key);
                    markSeen(device);
                    return;
                }
            }
            await legacySendKey(device, key);
        }
    }
    markSeen(device);
}

function isTizenRemoteUnsupported(err) {
    if (!err || !err.message) {
        return false;
    }
    return /unrecognized method value|ms\\.remote\\.control/i.test(err.message);
}

async function legacySendKey(device, key) {
    if (!device.ip) {
        throw new Error('No IP');
    }
    await new Promise((resolve, reject) => {
        const remote = new LegacyRemote({ ip: device.ip });
        remote.send(key, err => (err ? reject(err) : resolve()));
    });
}

async function hjSendKey(device, key) {
    if (!device.ip) {
        throw new Error('No IP');
    }
    const tv = new SamsungHJ({ ...HJ_DEVICE_CONFIG, ip: device.ip });
    await tv.init2();
    const identity = getHjIdentity(device.id);
    if (!identity) {
        throw new Error('Not paired (HJ)');
    }
    tv.identity = identity;
    if (tv.pairing) {
        tv.pairing.identity = identity;
    }
    try {
        await tv.connect();
        const powerKeys = new Set(['KEY_POWER', 'KEY_POWEROFF', 'KEY_POWERON']);
        if (tv.connection && powerKeys.has(key)) {
            tv.connection.sendKey(key, 'Press');
            await new Promise(resolve => setTimeout(resolve, 150));
            tv.connection.sendKey(key, 'Release');
            adapter.log.debug(`HJ sendKey ${key} (press/release) to ${device.name}`);
        } else {
            tv.sendKey(key);
            adapter.log.debug(`HJ sendKey ${key} to ${device.name}`);
        }
    } catch (e) {
        adapter.log.debug(`HJ sendKey failed (${key}) for ${device.name}: ${e.message}`);
        await tv.connect();
        const powerKeys = new Set(['KEY_POWER', 'KEY_POWEROFF', 'KEY_POWERON']);
        if (tv.connection && powerKeys.has(key)) {
            tv.connection.sendKey(key, 'Press');
            await new Promise(resolve => setTimeout(resolve, 150));
            tv.connection.sendKey(key, 'Release');
            adapter.log.debug(`HJ sendKey retry ${key} (press/release) to ${device.name}`);
        } else {
            tv.sendKey(key);
            adapter.log.debug(`HJ sendKey retry ${key} to ${device.name}`);
        }
    }
}

async function launchApp(device, appId) {
    if (device.api !== 'tizen') {
        adapter.log.warn(`launchApp only supported for Tizen devices (${device.name})`);
        return;
    }
    await tizenSend(device, {
        method: 'ms.channel.emit',
        params: {
            event: 'ed.apps.launch',
            to: 'host',
            data: {
                action_type: 'NATIVE_LAUNCH',
                appId,
            },
        },
    });
    markSeen(device);
}

async function selectSource(device, source) {
    const sourceKey = source.toUpperCase().startsWith('KEY_') ? source.toUpperCase() : `KEY_${source.toUpperCase()}`;
    await sendKey(device, sourceKey);
}

async function tizenSendKey(device, key) {
    try {
        await tizenSend(device, {
            method: 'ms.remote.control',
            params: {
                Cmd: 'Click',
                DataOfCmd: key,
                Option: 'false',
                TypeOfRemote: 'SendRemoteKey',
            },
        });
    } catch (e) {
        if (isTizenRemoteUnsupported(e)) {
            throw new Error('Tizen remote unsupported');
        }
        throw e;
    }
}

async function tizenSend(device, payload) {
    const token = getTizenToken(device.id);
    const urlCandidates = buildTizenWsCandidates(device, token, ['v2', 'v3']);
    let lastError;
    for (const url of urlCandidates) {
        try {
            await tizenWsRequest(url, payload);
            return;
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError || new Error('Tizen WS failed');
}

function buildTizenWsCandidates(device, token, apiVersions = ['v2']) {
    const nameBase64 = Buffer.from('ioBroker').toString('base64');
    const candidates = [];
    const added = new Set();
    const versions = Array.isArray(apiVersions) ? apiVersions : [apiVersions];
    const add = (protocol, port, apiVersion) => {
        const key = `${protocol}:${port}:${apiVersion}`;
        if (added.has(key)) {
            return;
        }
        added.add(key);
        let url = `${protocol}://${device.ip}:${port}/api/${apiVersion}/channels/samsung.remote.control?name=${nameBase64}`;
        if (token && token !== NO_TOKEN) {
            url += `&token=${token}`;
        }
        candidates.push(url);
    };

    if (device.protocol && device.port) {
        for (const v of versions) {
            add(device.protocol, device.port, v);
        }
    }
    for (const v of versions) {
        add('wss', 8002, v);
        add('ws', 8001, v);
    }
    return candidates;
}

function isTizenDenyEvent(eventName) {
    return (
        eventName === 'ms.channel.timeOut' ||
        eventName === 'ms.channel.unauthorized' ||
        eventName === 'ms.channel.error'
    );
}

async function tizenWsRequest(url, payload) {
    return new Promise((resolve, reject) => {
        const safeUrl = url.replace(/token=[^&]+/i, 'token=***');
        const ws = new WebSocket(url, buildTizenWsOptions(url));
        let timeout = setTimeout(() => {
            ws.terminate();
            reject(new Error('WebSocket timeout'));
        }, WS_CONNECT_TIMEOUT);

        ws.on('error', err => {
            clearTimeout(timeout);
            adapter.log.debug(`WS error: ${safeUrl}: ${err.message}`);
            reject(err);
        });

        let sent = false;
        ws.on('message', data => {
            let message;
            try {
                message = JSON.parse(data.toString());
            } catch (e) {
                return;
            }
            if (isTizenDenyEvent(message.event)) {
                clearTimeout(timeout);
                ws.close();
                return reject(new Error(`Tizen WS denied: ${message.event}`));
            }
            if (message.event === 'ms.error') {
                clearTimeout(timeout);
                ws.close();
                const msg = message?.data?.message || 'Tizen error';
                return reject(new Error(`Tizen error: ${msg}`));
            }
            if ((message.event === 'ms.channel.connect' || message.event === 'ms.channel.ready') && !sent) {
                sent = true;
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

        ws.on('open', () => {
            adapter.log.debug(`WS connected: ${safeUrl}`);
        });

        ws.on('close', (code, reason) => {
            adapter.log.debug(`WS closed: ${safeUrl} code=${code} reason=${reason ? reason.toString() : ''}`);
        });
    });
}

function buildTizenWsOptions(url) {
    try {
        const parsed = new URL(url);
        const originScheme = parsed.protocol === 'wss:' ? 'https' : 'http';
        const origin = `${originScheme}://${parsed.host}`;
        return {
            rejectUnauthorized: false,
            handshakeTimeout: WS_CONNECT_TIMEOUT,
            perMessageDeflate: false,
            headers: {
                Origin: origin,
                'User-Agent': 'ioBroker.samsungtv',
            },
        };
    } catch (e) {
        return { rejectUnauthorized: false, handshakeTimeout: WS_CONNECT_TIMEOUT, perMessageDeflate: false };
    }
}

async function pairTizen(device) {
    adapter.log.debug(`Pairing (Tizen) started for ${device.name} (${device.ip})`);
    await refreshTizenCapabilities(device);
    const urls = buildTizenWsCandidates(device, '', ['v2', 'v3']);

    let lastError;
    for (const url of urls) {
        try {
            const token = await pairTizenWithUrl(url);
            const scheme = url.startsWith('wss://') ? 'wss' : 'ws';
            const apiVersion = url.includes('/api/v3/') ? 'v3' : 'v2';
            if (token === NO_TOKEN) {
                adapter.log.debug(
                    `Pairing (Tizen) succeeded without token for ${device.name} via ${scheme} ${apiVersion}`,
                );
            } else {
                adapter.log.debug(`Pairing (Tizen) succeeded for ${device.name} via ${scheme} ${apiVersion}`);
            }
            if (token === NO_TOKEN && device.tokenAuthSupport === true) {
                throw new Error('Token required but not granted by TV');
            }
            return token;
        } catch (e) {
            const scheme = url.startsWith('wss://') ? 'wss' : 'ws';
            const apiVersion = url.includes('/api/v3/') ? 'v3' : 'v2';
            adapter.log.debug(`Pairing (Tizen) failed for ${device.name} via ${scheme} ${apiVersion}: ${e.message}`);
            lastError = e;
        }
    }
    if (
        lastError &&
        /Pairing timeout|ms\\.channel\\.timeOut|ms\\.channel\\.unauthorized/.test(lastError.message || '')
    ) {
        adapter.log.warn(
            'Pairing failed: no prompt/authorization from TV. Check Device Connection Manager > Access Notification, clear the Device List, and ensure same subnet.',
        );
    }
    throw lastError || new Error('Pairing failed');
}

async function pairTizenWithUrl(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, buildTizenWsOptions(url));
        let done = false;
        let timeout = setTimeout(() => {
            ws.terminate();
            if (done) {
                return;
            }
            done = true;
            reject(new Error('Pairing timeout'));
        }, PAIRING_TIMEOUT);

        ws.on('error', err => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timeout);
            adapter.log.debug(`Pairing WS error: ${err.message}`);
            reject(err);
        });

        ws.on('open', () => {
            adapter.log.debug('Pairing WS connected');
        });

        ws.on('close', (code, reason) => {
            if (done) {
                return;
            }
            adapter.log.debug(`Pairing WS closed code=${code} reason=${reason ? reason.toString() : ''}`);
        });

        ws.on('message', data => {
            let message;
            try {
                message = JSON.parse(data.toString());
            } catch (e) {
                return;
            }
            if (isTizenDenyEvent(message.event)) {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timeout);
                ws.close();
                return reject(new Error(`Tizen WS denied: ${message.event}`));
            }
            if (message.event === 'ms.channel.connect') {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timeout);
                const token = message?.data?.token || message?.data?.data?.token || '';
                ws.close();
                if (!token) {
                    return resolve(NO_TOKEN);
                }
                resolve(token);
            }
        });
    });
}

async function hjRequestPin(device) {
    adapter.log.debug(`Pairing (HJ) PIN requested for ${device.name} (${device.ip})`);
    const tv = new SamsungHJ({ ...HJ_DEVICE_CONFIG, ip: device.ip });
    await tv.init2();
    await tv.requestPin();
}

async function hjConfirmPin(device, pin) {
    if (!pin) {
        throw new Error('Missing PIN');
    }
    adapter.log.debug(`Pairing (HJ) confirm PIN for ${device.name} (${device.ip})`);
    const tv = new SamsungHJ({ ...HJ_DEVICE_CONFIG, ip: device.ip });
    await tv.init2();
    const identity = await tv.confirmPin(pin);
    adapter.log.debug(`Pairing (HJ) succeeded for ${device.name}`);
    return identity;
}

async function onMessage(obj) {
    if (!obj || !obj.command) {
        return;
    }

    if (obj.command === 'discover') {
        const timeout = (obj.message && obj.message.timeout) || adapter.config.discoveryTimeout || 5;
        try {
            const result = await performDiscovery(false, timeout);
            adapter.sendTo(obj.from, obj.command, { ok: true, devices: result, lastScan: lastDiscovery }, obj.callback);
        } catch (e) {
            adapter.sendTo(obj.from, obj.command, { ok: false, error: e.message }, obj.callback);
        }
        return;
    }

    if (obj.command === 'getDiscovered') {
        const devices = Array.from(discoveredByIp.values());
        adapter.sendTo(obj.from, obj.command, { ok: true, devices, lastScan: lastDiscovery }, obj.callback);
        return;
    }

    if (obj.command === 'pair') {
        const deviceId = obj.message && obj.message.id;
        const pin = obj.message && obj.message.pin;
        adapter.log.debug(`Pairing request received for ${deviceId || 'unknown device'}`);
        let device = devicesById.get(deviceId);
        if (!device && obj.message && obj.message.device) {
            const d = obj.message.device;
            const id = normalizeId(d.id || d.uuid || d.usn || deviceId || d.ip || '');
            device = {
                id,
                name: d.name || `tv-${id.slice(0, 6)}`,
                displayName: d.displayName || d.name || d.model || '',
                ip: d.ip || '',
                mac: d.mac || '',
                model: d.model || '',
                api: d.api || 'tizen',
                protocol: d.protocol || '',
                port: d.port || 0,
                uuid: d.uuid || '',
                source: d.source || 'pair',
            };
            if (device.ip) {
                discoveredByIp.set(device.ip, device);
            }
        }
        if (!device) {
            adapter.sendTo(obj.from, obj.command, { ok: false, error: 'Unknown device' }, obj.callback);
            return;
        }
        try {
            if (device.api === 'hj') {
                try {
                    if (!pin) {
                        await hjRequestPin(device);
                        adapter.sendTo(obj.from, obj.command, { ok: true, needsPin: true }, obj.callback);
                        return;
                    }
                    const identity = await hjConfirmPin(device, pin);
                    setInMemoryHjIdentity(device.id, identity);
                    await adapter.setStateAsync(`${device.name}.info.paired`, true, true);
                    adapter.sendTo(obj.from, obj.command, { ok: true, identity }, obj.callback);
                    return;
                } catch (e) {
                    adapter.log.warn(`HJ pairing failed for ${device.name}: ${e.message}`);
                    adapter.sendTo(
                        obj.from,
                        obj.command,
                        { ok: false, error: `HJ pairing failed: ${e.message}` },
                        obj.callback,
                    );
                    return;
                }
            }

            const token = await pairTizen(device);
            setInMemoryToken(device.id, token);
            if (device.api !== 'tizen') {
                device.api = 'tizen';
                await updateDeviceInfoStates(device);
            }
            await adapter.setStateAsync(`${device.name}.info.paired`, true, true);
            adapter.sendTo(obj.from, obj.command, { ok: true, token }, obj.callback);
        } catch (e) {
            adapter.log.debug(`Pairing failed for ${device.name}: ${e.message}`);
            adapter.sendTo(obj.from, obj.command, { ok: false, error: e.message }, obj.callback);
        }
        return;
    }
}

async function performDiscovery(updateKnownDevices, timeoutOverride) {
    const timeout = Math.max(2, parseInt(timeoutOverride || adapter.config.discoveryTimeout, 10) || 5) * 1000;
    const discovered = [];

    adapter.log.debug(
        `Discovery started (ssdp=${!!adapter.config.enableSsdp}, mdns=${!!adapter.config.enableMdns}, timeout=${timeout / 1000}s)`,
    );

    let ssdpCount = 0;
    let mdnsCount = 0;

    if (adapter.config.enableSsdp) {
        const ssdp = await discoverSsdp(timeout);
        ssdpCount = ssdp.length;
        adapter.log.debug(`SSDP discovery finished: ${ssdpCount} candidates`);
        discovered.push(...ssdp);
    }

    if (adapter.config.enableMdns) {
        const mdns = await discoverMdns(timeout);
        mdnsCount = mdns.length;
        adapter.log.debug(`mDNS discovery finished: ${mdnsCount} candidates`);
        discovered.push(...mdns);
    }

    const byIp = new Map();
    for (const entry of discovered) {
        if (!entry.ip) {
            continue;
        }
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
                const macKey = normalizeMac(info.mac || '');
                const match = devicesById.get(info.id) || (macKey ? devicesByMac.get(macKey) : null);
                if (match) {
                    if (info.ip && match.ip !== info.ip) {
                        match.ip = info.ip;
                    }
                    if (info.mac && !match.mac) {
                        match.mac = macKey;
                        devicesByMac.set(match.mac, match);
                    }
                    if (info.model && !match.model) {
                        match.model = info.model;
                    }
                    match.api = info.api || match.api;
                    match.protocol = info.protocol || match.protocol;
                    match.port = info.port || match.port;
                    if (typeof info.tokenAuthSupport === 'boolean') {
                        match.tokenAuthSupport = info.tokenAuthSupport;
                    }
                    if (typeof info.remoteAvailable === 'boolean') {
                        match.remoteAvailable = info.remoteAvailable;
                    }
                    if (typeof info.hjAvailable === 'boolean') {
                        match.hjAvailable = info.hjAvailable;
                    }
                    await updateDeviceInfoStates(match);
                    updateConfigDeviceFromDiscovery(match, info);
                }
            }
        }
    }

    lastDiscovery = Date.now();
    adapter.log.debug(
        `Discovery finished: ssdp=${ssdpCount}, mdns=${mdnsCount}, unique=${byIp.size}, probed=${results.length}`,
    );
    return results;
}

async function discoverSsdp(timeoutMs) {
    return new Promise(resolve => {
        const results = [];
        const client = new SsdpClient();
        client.on('response', (headers, statusCode, rinfo) => {
            const server = headers.SERVER || headers.Server || headers.server || '';
            const st = headers.ST || headers.St || headers.st || '';
            const usn = headers.USN || headers.Usn || headers.usn || '';
            const location = headers.LOCATION || headers.Location || headers.location || '';
            if (!/samsung/i.test(`${server} ${st} ${usn}`)) {
                return;
            }

            adapter.log.debug(
                `SSDP response: ip=${rinfo.address} st=${st || '-'} usn=${usn || '-'} server=${server || '-'}`,
            );

            results.push({
                ip: rinfo.address,
                usn,
                location,
                st,
                server,
                source: ['ssdp'],
            });
        });
        client.search('ssdp:all');
        setTimeout(() => {
            client.stop();
            resolve(results);
        }, timeoutMs);
    });
}

async function discoverMdns(timeoutMs) {
    const services = (adapter.config.mdnsServices || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => s.replace(/^_/, ''));

    if (!services.length) {
        return [];
    }

    adapter.log.debug(`mDNS discovery started for services: ${services.join(', ')}`);

    const bonjour = new Bonjour();
    const results = new Map();
    const browsers = [];

    for (const svc of services) {
        const [type] = svc.split('.');
        const browser = bonjour.find({ type, protocol: 'tcp' }, service => {
            const name = (service.name || '').toLowerCase();
            const txt = service.txt || {};
            const manufacturer = (txt.manufacturer || txt.mf || '').toLowerCase();
            if (!name.includes('samsung') && !manufacturer.includes('samsung') && !svc.includes('samsung')) {
                return;
            }
            const addresses = Array.isArray(service.addresses) ? service.addresses : [];
            for (const ip of addresses) {
                if (!ip || ip.includes(':')) {
                    continue;
                } // ignore IPv6 for now
                adapter.log.debug(
                    `mDNS service: ${svc} name=${service.name || '-'} ip=${ip} manufacturer=${manufacturer || '-'}`,
                );
                results.set(ip, { ip, name: service.name, source: ['mdns'], mdns: svc });
            }
        });
        browsers.push(browser);
    }

    return new Promise(resolve => {
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

function parseTokenAuthSupport(info) {
    const device = info?.device || info || {};
    const raw =
        device.TokenAuthSupport ??
        device.tokenAuthSupport ??
        device.tokenAuthSupported ??
        info?.TokenAuthSupport ??
        info?.tokenAuthSupport ??
        info?.tokenAuthSupported;
    if (typeof raw === 'boolean') {
        return raw;
    }
    if (typeof raw === 'string') {
        return raw.toLowerCase() === 'true';
    }
    return undefined;
}

function parseIsSupport(info) {
    const raw = info?.isSupport;
    if (!raw) {
        return {};
    }
    if (typeof raw === 'object') {
        return raw;
    }
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch (e) {
            return {};
        }
    }
    return {};
}

function isLikelyHjSeries(result) {
    const modelName = (result.model || '').toUpperCase();
    const code = (result.uuid || '').toUpperCase();
    const combined = `${modelName} ${code}`;
    if (/\\b1[45]_/.test(combined)) {
        return true;
    }
    if (/\\b[A-Z]{2}\\d{2}[HJ][A-Z]?\\d*/.test(modelName)) {
        return true;
    }
    if (/\\b(?:UE|GQ|QE)\\d{2}J/.test(modelName)) {
        return true;
    }
    if (modelName.includes('JU') || modelName.includes('JS')) {
        return true;
    }
    return false;
}

function applyHjInfo(result, info) {
    result.name = result.name || info.DeviceName || '';
    result.model = result.model || info.ModelName || info.Model || '';
    result.uuid = result.uuid || info.UDN || info.DUID || info.DeviceID || '';
    if (!result.id) {
        result.id = normalizeId(info.DeviceID || info.DUID || info.UDN || '');
    }
}

async function probeDevice(ip, seed) {
    adapter.log.debug(`Probing device ${ip}`);
    const result = {
        ip,
        source: seed.source || [],
        name: seed.name || '',
        model: '',
        api: 'unknown',
        protocol: '',
        port: 0,
        uuid: '',
        id: '',
        mac: '',
    };

    // try tizen https
    const tizenSecure = await fetchTizenInfo(ip, 'wss', 8002, 2000);
    if (tizenSecure) {
        result.api = 'tizen';
        result.protocol = 'wss';
        result.port = 8002;
        applyTizenInfo(result, tizenSecure);
        adapter.log.debug(`Probe result ${ip}: api=tizen protocol=wss port=8002`);
    }

    // try tizen http if not found
    if (result.api !== 'tizen') {
        const tizen = await fetchTizenInfo(ip, 'ws', 8001, 2000);
        if (tizen) {
            result.api = 'tizen';
            result.protocol = 'ws';
            result.port = 8001;
            applyTizenInfo(result, tizen);
            adapter.log.debug(`Probe result ${ip}: api=tizen protocol=ws port=8001`);
        }
    }

    // try HJ info (used later for API decision)
    const hj = await fetchHjInfo(ip, HJ_INFO_TIMEOUT);
    if (hj) {
        result.hjAvailable = true;
        applyHjInfo(result, hj);
    }

    // try UPnP description
    if (seed.location) {
        const desc = await fetchUpnpDescription(seed.location, 2000);
        if (desc) {
            if (!result.model) {
                result.model = desc.modelName || '';
            }
            if (!result.name) {
                result.name = desc.friendlyName || '';
            }
            if (!result.uuid && desc.UDN) {
                result.uuid = desc.UDN;
            }
            adapter.log.debug(`UPnP description for ${ip}: model=${result.model || '-'} name=${result.name || '-'}`);
        }
    }

    if (!result.id) {
        result.id = normalizeId(result.uuid || seed.usn || seed.st || seed.ip || '');
    }

    if (!result.name) {
        result.name = `tv-${result.id.slice(0, 6)}`;
    }

    const mac = await getMacForIp(ip);
    if (mac) {
        result.mac = mac;
    }
    if (mac && (!result.id || looksLikeIp(result.id))) {
        result.id = mac;
    }

    // decide API after UPnP/model info
    const hjSeries = isLikelyHjSeries(result);
    adapter.log.debug(
        `HJ check ${ip}: model=${result.model || '-'} uuid=${result.uuid || '-'} hjSeries=${hjSeries} hjAvailable=${result.hjAvailable}`,
    );
    if (result.api === 'unknown' || hjSeries) {
        if (!result.hjAvailable && hjSeries) {
            const hjPort = await checkPort(ip, 8000, 1200);
            if (hjPort) {
                result.hjAvailable = true;
            }
        }
        if (hjSeries) {
            if (!result.hjAvailable) {
                adapter.log.warn(`Model suggests H/J-series but HJ port not reachable for ${ip}; forcing HJ`);
            }
            result.api = 'hj';
            result.port = 8000;
            result.protocol = 'ws';
            adapter.log.debug(`Probe result ${ip}: api=hj protocol=ws port=8000`);
        } else if (result.hjAvailable) {
            result.api = 'hj';
            result.port = 8000;
            result.protocol = 'ws';
            adapter.log.debug(`Probe result ${ip}: api=hj protocol=ws port=8000`);
        }
    }

    if (result.id) {
        adapter.log.debug(
            `Probe result ${ip}: id=${result.id || '-'} mac=${result.mac || '-'} model=${result.model || '-'} api=${result.api}`,
        );
        return result;
    }

    adapter.log.debug(`Probe failed for ${ip}`);
    return null;
}

function applyTizenInfo(result, info) {
    const device = info.device || info || {};
    result.name = result.name || device.name || info.name || '';
    result.model = device.modelName || device.model || result.model || '';
    result.uuid = device.id || device.udn || device.uuid || result.uuid || '';
    result.id = normalizeId(device.id || device.udn || device.uuid || info.id || result.id || '');
    result.mac = normalizeMac(device.wifiMac || device.mac || result.mac || '');
    const tokenAuthSupport = parseTokenAuthSupport(info);
    if (typeof tokenAuthSupport === 'boolean') {
        result.tokenAuthSupport = tokenAuthSupport;
    }
    const isSupport = parseIsSupport(info);
    if (typeof isSupport.remote_available === 'boolean') {
        result.remoteAvailable = isSupport.remote_available;
    }
}

async function fetchTizenInfo(ip, protocol, port, timeoutMs) {
    const url = `${protocol === 'wss' ? 'https' : 'http'}://${ip}:${port}/api/v2/`;
    try {
        const res = await fetchWithTimeout(url, timeoutMs, { agent: protocol === 'wss' ? httpsAgent : undefined });
        if (!res) {
            return null;
        }
        return res;
    } catch (e) {
        return null;
    }
}

async function refreshTizenCapabilities(device) {
    if (!device || !device.ip) {
        return;
    }
    const info =
        (await fetchTizenInfo(device.ip, 'wss', 8002, 2000)) || (await fetchTizenInfo(device.ip, 'ws', 8001, 2000));
    if (!info) {
        return;
    }
    applyTizenInfo(device, info);
    await updateDeviceInfoStates(device);
}

async function fetchHjInfo(ip, timeoutMs) {
    const url = `http://${ip}:8001/ms/1.0/`;
    try {
        const res = await fetchWithTimeout(url, timeoutMs);
        if (!res) {
            return null;
        }
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
        if (!resp.ok) {
            return null;
        }
        const text = await resp.text();
        const xml = xmlParser.parse(text);
        const device = xml?.root?.device || xml?.device || {};
        return {
            friendlyName: device.friendlyName,
            manufacturer: device.manufacturer,
            modelName: device.modelName,
            UDN: normalizeId(device.UDN || ''),
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
        if (!resp.ok) {
            return null;
        }
        return await resp.json();
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function checkPort(ip, port, timeoutMs) {
    return new Promise(resolve => {
        const socket = new net.Socket();
        let done = false;
        const finish = result => {
            if (done) {
                return;
            }
            done = true;
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs);
        socket.once('error', () => finish(false));
        socket.once('timeout', () => finish(false));
        socket.connect(port, ip, () => finish(true));
    });
}

function pingHost(ip, timeoutMs) {
    if (pingUnavailable) {
        return Promise.resolve(null);
    }
    return new Promise(resolve => {
        const timeoutSec = Math.max(1, Math.ceil((timeoutMs || 1000) / 1000));
        execFile('ping', ['-c', '1', '-W', String(timeoutSec), ip], { timeout: (timeoutMs || 1000) + 500 }, err => {
            if (err) {
                if (err.code === 'ENOENT') {
                    pingUnavailable = true;
                    adapter.log.debug('ping command not available; skipping ICMP power checks.');
                    return resolve(null);
                }
                return resolve(false);
            }
            resolve(true);
        });
    });
}

async function getMacForIp(ip) {
    if (!ip) {
        return '';
    }
    try {
        const { exec } = require('child_process');
        return await new Promise(resolve => {
            exec(`ip neigh show ${ip}`, (err, stdout) => {
                if (!err && stdout) {
                    const match = stdout.match(/lladdr\s+([0-9a-f:]{17})/i);
                    if (match) {
                        return resolve(normalizeMac(match[1]));
                    }
                }
                exec(`arp -n ${ip}`, (err2, stdout2) => {
                    if (!err2 && stdout2) {
                        const match2 = stdout2.match(/([0-9a-f:]{17})/i);
                        if (match2) {
                            return resolve(normalizeMac(match2[1]));
                        }
                    }
                    resolve('');
                });
            });
        });
    } catch (e) {
        return '';
    }
}

function looksLikeIp(value) {
    if (!value || typeof value !== 'string') {
        return false;
    }
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(value.trim());
}

let arpCache = { ts: 0, map: new Map() };

async function refreshIpFromMac(device) {
    if (!device || !device.mac) {
        return false;
    }
    const mac = normalizeMac(device.mac);
    const ip = await getIpForMac(mac);
    if (ip && ip !== device.ip) {
        device.ip = ip;
        await updateDeviceInfoStates(device);
        adapter.log.debug(`IP updated for ${device.name} via MAC ${mac}: ${ip}`);
        return true;
    }
    return false;
}

async function getIpForMac(mac) {
    if (!mac) {
        return '';
    }
    const table = await getArpTable();
    return table.get(normalizeMac(mac)) || '';
}

async function getArpTable() {
    const now = Date.now();
    if (now - arpCache.ts < 10000 && arpCache.map.size) {
        return arpCache.map;
    }

    const map = new Map();
    try {
        const { exec } = require('child_process');
        await new Promise(resolve => {
            exec('ip neigh', (err, stdout) => {
                if (!err && stdout) {
                    const lines = stdout.split('\n');
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
            const { exec } = require('child_process');
            await new Promise(resolve => {
                exec('arp -an', (err, stdout) => {
                    if (!err && stdout) {
                        const lines = stdout.split('\n');
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
