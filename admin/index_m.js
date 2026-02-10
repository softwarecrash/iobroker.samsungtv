/* global $, sendTo, systemDictionary, translateAll, _ */

"use strict";

let onChangeCb;
let devices = [];
let discovered = [];
let tokens = { tizen: {}, hj: {} };
let themeObserverInitialized = false;
let discoveredRefreshTimer;

systemDictionary = {
    "Samsung TV": { "de": "Samsung TV" },
    "Discovery Settings": { "de": "Discovery-Einstellungen" },
    "Auto Scan": { "de": "Automatischer Scan" },
    "Auto Scan Interval (s)": { "de": "Scan-Intervall (s)" },
    "Discovery Timeout (s)": { "de": "Discovery-Timeout (s)" },
    "Enable SSDP": { "de": "SSDP aktivieren" },
    "Enable mDNS": { "de": "mDNS aktivieren" },
    "mDNS Services": { "de": "mDNS Services" },
    "Enable Wake-on-LAN": { "de": "Wake-on-LAN aktivieren" },
    "Power Poll Interval (s)": { "de": "Power-Poll-Intervall (s)" },
    "Discovered TVs": { "de": "Gefundene TVs" },
    "Manual Add": { "de": "Manuelles Hinzuf\u00fcgen" },
    "Scan": { "de": "Scannen" },
    "Added TVs": { "de": "Hinzugefügte TVs" },
    "Name": { "de": "Name" },
    "IP": { "de": "IP" },
    "MAC (optional)": { "de": "MAC (optional)" },
    "Model": { "de": "Modell" },
    "ID": { "de": "ID" },
    "API": { "de": "API" },
    "API (tizen/hj/auto)": { "de": "API (tizen/hj/auto)" },
    "Protocol (wss/ws/auto)": { "de": "Protokoll (wss/ws/auto)" },
    "Port (optional)": { "de": "Port (optional)" },
    "Device ID/UUID (optional)": { "de": "Ger\u00e4te-ID/UUID (optional)" },
    "Found Via": { "de": "Gefunden über" },
    "Action": { "de": "Aktion" },
    "Paired": { "de": "Gepairt" },
    "Add": { "de": "Hinzufügen" },
    "Add device": { "de": "Ger\u00e4t hinzuf\u00fcgen" },
    "Remove": { "de": "Entfernen" },
    "Pair": { "de": "Pair" },
    "Set Token": { "de": "Token setzen" },
    "on save adapter restarts with new config immediately": {
        "de": "Beim Speichern wird der Adapter automatisch neu gestartet."
    },
    "No devices found": { "de": "Keine Ger\u00e4te gefunden" },
    "No devices added": { "de": "Keine Ger\u00e4te hinzugef\u00fcgt" },
    "Yes": { "de": "Ja" },
    "No": { "de": "Nein" },
    "Scanning...": { "de": "Suche l\u00e4uft..." },
    "Last scan": { "de": "Letzter Scan" },
    "Pairing failed": { "de": "Pairing fehlgeschlagen" },
    "Discovery failed": { "de": "Suche fehlgeschlagen" },
    "Enter the PIN shown on the TV:": { "de": "Bitte die PIN eingeben, die am TV angezeigt wird:" },
    "Please provide IP or MAC.": { "de": "Bitte IP oder MAC angeben." },
    "Device already exists.": { "de": "Ger\u00e4t existiert bereits." },
    "MAC helps to track DHCP changes.": { "de": "MAC hilft bei DHCP-\u00c4nderungen." }
};

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

function normalizeMacInput(value) {
    return (value || "").trim().toLowerCase();
}

function normalizeApiInput(value) {
    const v = (value || "").trim().toLowerCase();
    if (v === "tizen") return "tizen";
    if (v === "hj") return "hj";
    if (v === "legacy") return "legacy";
    if (v === "auto" || v === "unknown" || v === "") return "unknown";
    return "unknown";
}

function normalizeProtocolInput(value) {
    const v = (value || "").trim().toLowerCase();
    if (v === "ws" || v === "wss") return v;
    return "";
}

function parseTokens(tokensStr) {
    if (!tokensStr || typeof tokensStr !== "string") return { tizen: {}, hj: {} };
    try {
        const obj = JSON.parse(tokensStr);
        return {
            tizen: obj.tizen || {},
            hj: obj.hj || {}
        };
    } catch (e) {
        return { tizen: {}, hj: {} };
    }
}

function serializeTokens() {
    return JSON.stringify(tokens);
}

function load(settings, onChange) {
    applyThemeFallback();
    setupThemeObserver();
    onChangeCb = onChange;

    // standard values
    for (const key in settings) {
        if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
        const $el = $("#" + key + ".value");
        if (!$el.length) continue;
        if ($el.attr("type") === "checkbox") {
            $el.prop("checked", settings[key]).change(() => onChange());
        } else {
            $el.val(settings[key]).change(() => onChange()).keyup(function () {
                $(this).trigger("change");
            });
        }
    }

    devices = Array.isArray(settings.devices) ? settings.devices : [];
    tokens = parseTokens(settings.tokens || "");

    renderDevices();
    renderDiscovered();
    fetchDiscovered();

    $("#btn-scan").off("click").on("click", () => scanDevices());
    $("#btn-add-manual").off("click").on("click", () => addManualDevice());
    onChange(false);
    if (typeof M !== "undefined" && M.updateTextFields) {
        M.updateTextFields();
    }
    activateLabels();
    initSelects();
    $(document).off("change keyup", ".input-field input", activateLabels)
        .on("change keyup", ".input-field input", activateLabels);
}

function save(callback) {
    const obj = {};

    $(".value").each(function () {
        const $this = $(this);
        if ($this.attr("type") === "checkbox") {
            obj[$this.attr("id")] = $this.prop("checked");
        } else {
            obj[$this.attr("id")] = $this.val();
        }
    });

    obj.devices = devices;
    obj.tokens = serializeTokens();

    callback(obj);
}

function renderDiscovered() {
    const $tbody = $("#discovered-table tbody");
    $tbody.empty();
    const filtered = discovered.filter((d) => !isAlreadyAdded(d));
    if (!filtered.length) {
        $tbody.append(`<tr><td colspan="7" class="grey-text text-darken-1">${_("No devices found")}</td></tr>`);
        return;
    }

    const labels = getTableLabels();
    filtered.forEach((d, idx) => {
        const sources = (d.source || []).join(", ");
        const name = d.name || d.model || d.ip || "";
        const row = $(
            `<tr>
                <td data-title="${labels.name}">${name}</td>
                <td data-title="${labels.ip}">${d.ip || ""}</td>
                <td data-title="${labels.model}">${d.model || ""}</td>
                <td data-title="${labels.id}">${d.id || ""}</td>
                <td data-title="${labels.api}">${d.api || ""}</td>
                <td data-title="${labels.foundVia}">${sources}</td>
                <td data-title="${labels.action}">
                    <button class="btn btn-small waves-effect values-buttons" type="button" data-idx="${idx}">${_("Add")}</button>
                </td>
            </tr>`
        );
        row.find("button").on("click", () => addDeviceFromDiscovery(d));
        $tbody.append(row);
    });
}

function isAlreadyAdded(discoveredDevice) {
    if (!discoveredDevice) return false;
    const did = (discoveredDevice.id || "").trim();
    const dmac = normalizeMacInput(discoveredDevice.mac || "");
    const dip = (discoveredDevice.ip || "").trim();
    return devices.some((dev) => {
        if (!dev) return false;
        if (did && dev.id === did) return true;
        if (dmac && normalizeMacInput(dev.mac || "") === dmac) return true;
        if (!did && !dmac && dip && dev.ip === dip) return true;
        return false;
    });
}

function renderDevices() {
    const $tbody = $("#devices-table tbody");
    $tbody.empty();
    if (!devices.length) {
        $tbody.append(`<tr><td colspan="7" class="grey-text text-darken-1">${_("No devices added")}</td></tr>`);
        return;
    }

    const labels = getTableLabels();
    devices.forEach((d, idx) => {
        const paired = isDevicePaired(d);
        const pairedText = paired ? _("Yes") : _("No");
        const pairedClass = paired ? "green-text text-darken-2" : "red-text text-darken-2";
        const apiValue = d.api && d.api !== "unknown" ? d.api : "auto";

        const row = $(
            `<tr>
                <td data-title="${labels.name}"><input type="text" class="device-name" data-idx="${idx}" value="${d.name || ""}" /></td>
                <td data-title="${labels.ip}"><input type="text" class="device-ip" data-idx="${idx}" value="${d.ip || ""}" /></td>
                <td data-title="${labels.model}">${d.model || ""}</td>
                <td data-title="${labels.id}">${d.id || ""}</td>
                <td data-title="${labels.api}">
                    <select class="device-api" data-idx="${idx}">
                        <option value="auto"${apiValue === "auto" ? " selected" : ""}>auto</option>
                        <option value="tizen"${apiValue === "tizen" ? " selected" : ""}>tizen</option>
                        <option value="hj"${apiValue === "hj" ? " selected" : ""}>hj</option>
                        <option value="legacy"${apiValue === "legacy" ? " selected" : ""}>legacy</option>
                    </select>
                </td>
                <td data-title="${labels.paired}" class="${pairedClass}">${pairedText}</td>
                <td data-title="${labels.action}">
                    <button class="btn btn-small waves-effect values-buttons btn-pair" type="button" data-idx="${idx}">${_("Pair")}</button>
                    <button class="btn btn-small waves-effect values-buttons btn-remove" type="button" data-idx="${idx}">${_("Remove")}</button>
                </td>
            </tr>`
        );

        row.find(".device-name").on("change", function () {
            const i = parseInt($(this).data("idx"), 10);
            const val = sanitizeName($(this).val());
            devices[i].name = val || devices[i].name;
            onChangeCb && onChangeCb();
            renderDevices();
        });

        row.find(".device-ip").on("change", function () {
            const i = parseInt($(this).data("idx"), 10);
            devices[i].ip = $(this).val();
            onChangeCb && onChangeCb();
        });

        row.find(".device-api").on("change", function () {
            const i = parseInt($(this).data("idx"), 10);
            const value = normalizeApiInput($(this).val());
            devices[i].api = value;
            onChangeCb && onChangeCb();
            renderDevices();
        });

        row.find(".btn-remove").on("click", function () {
            const i = parseInt($(this).data("idx"), 10);
            removeDevice(i);
        });

        row.find(".btn-pair").on("click", function () {
            const i = parseInt($(this).data("idx"), 10);
            pairDevice(devices[i]);
        });

        $tbody.append(row);
    });
    initSelects();
}

function addDeviceFromDiscovery(d) {
    if (!d || !d.id) return;

    if (devices.find((x) => x.id === d.id)) {
        return;
    }

    const name = sanitizeName(d.name || d.model || `tv-${d.id.slice(0, 6)}`);
    devices.push({
        id: d.id,
        name,
        displayName: d.name || d.model || name,
        ip: d.ip || "",
        mac: d.mac || "",
        model: d.model || "",
        api: d.api || "unknown",
        protocol: d.protocol || "",
        port: d.port || 0,
        uuid: d.uuid || "",
        source: d.source || "",
        hjAvailable: typeof d.hjAvailable === "boolean" ? d.hjAvailable : undefined,
        tokenAuthSupport: typeof d.tokenAuthSupport === "boolean" ? d.tokenAuthSupport : undefined,
        remoteAvailable: typeof d.remoteAvailable === "boolean" ? d.remoteAvailable : undefined
    });

    onChangeCb && onChangeCb();
    renderDevices();
}

function addManualDevice() {
    const nameInput = ($("#manualName").val() || "").trim();
    const ip = ($("#manualIp").val() || "").trim();
    const mac = normalizeMacInput($("#manualMac").val());
    const idInput = ($("#manualId").val() || "").trim();
    const api = normalizeApiInput($("#manualApi").val());
    const protocol = normalizeProtocolInput($("#manualProtocol").val());
    const port = parseInt($("#manualPort").val(), 10) || 0;

    if (!ip && !mac) {
        alert(_("Please provide IP or MAC."));
        return;
    }

    const id = (idInput || mac || ip || "").trim();
    if (!id) {
        alert(_("Please provide IP or MAC."));
        return;
    }

    if (devices.find((x) => x.id === id)) {
        alert(_("Device already exists."));
        return;
    }

    const displayName = nameInput || ip || mac || `tv-${id.slice(0, 6)}`;
    const safeName = sanitizeName(displayName) || `tv-${id.slice(0, 6)}`;

    devices.push({
        id,
        name: safeName,
        displayName,
        ip,
        mac,
        model: "",
        api,
        protocol,
        port,
        uuid: "",
        source: "manual"
    });

    onChangeCb && onChangeCb();
    renderDevices();
    clearManualForm();
}

function clearManualForm() {
    $("#manualName").val("");
    $("#manualIp").val("");
    $("#manualMac").val("");
    $("#manualId").val("");
    $("#manualProtocol").val("auto");
    $("#manualPort").val("");
    $("#manualApi").val("auto");
    activateLabels();
    initSelects();
    if (typeof M !== "undefined" && M.updateTextFields) {
        M.updateTextFields();
    }
}

function removeDevice(idx) {
    const dev = devices[idx];
    if (dev && dev.id) {
        if (tokens.tizen[dev.id]) delete tokens.tizen[dev.id];
        if (tokens.hj[dev.id]) delete tokens.hj[dev.id];
    }
    devices.splice(idx, 1);
    onChangeCb && onChangeCb();
    renderDevices();
}

function isDevicePaired(dev) {
    if (!dev || !dev.id) return false;
    if (dev.api === "hj") return !!tokens.hj[dev.id];
    if (dev.api === "legacy") return false;
    if (dev.api === "unknown") return !!tokens.tizen[dev.id] || !!tokens.hj[dev.id];
    return !!tokens.tizen[dev.id];
}

function pairDevice(dev) {
    if (!dev || !dev.id) return;
    if (dev.api === "hj") {
        sendTo(null, "pair", { id: dev.id, device: dev }, (res) => {
            if (res && res.ok && res.identity) {
                tokens.hj[dev.id] = res.identity;
                onChangeCb && onChangeCb();
                renderDevices();
                return;
            }
            if (res && res.ok && res.needsPin) {
                const pin = window.prompt(_("Enter the PIN shown on the TV:"));
                if (!pin) return;
                sendTo(null, "pair", { id: dev.id, pin, device: dev }, (res2) => {
                    if (res2 && res2.ok && res2.identity) {
                        tokens.hj[dev.id] = res2.identity;
                        onChangeCb && onChangeCb();
                        renderDevices();
                    } else {
                        alert(res2 && res2.error ? res2.error : _("Pairing failed"));
                    }
                });
                return;
            }
            alert(res && res.error ? res.error : _("Pairing failed"));
        });
        return;
    }

    sendTo(null, "pair", { id: dev.id, device: dev }, (res) => {
        if (res && res.ok && res.token) {
            tokens.tizen[dev.id] = res.token;
            onChangeCb && onChangeCb();
            renderDevices();
        } else {
            alert(res && res.error ? res.error : _("Pairing failed"));
        }
    });
}

function scanDevices() {
    $("#scan-status").text(_("Scanning..."));
    sendTo(null, "discover", { timeout: parseInt($("#discoveryTimeout").val(), 10) || 5 }, (res) => {
        if (res && res.ok) {
            discovered = res.devices || [];
        } else {
            discovered = [];
            alert(res && res.error ? res.error : _("Discovery failed"));
        }
        updateScanStatus(res && res.lastScan);
        renderDiscovered();
    });
}

function fetchDiscovered() {
    if (discoveredRefreshTimer) {
        clearTimeout(discoveredRefreshTimer);
        discoveredRefreshTimer = null;
    }
    sendTo(null, "getDiscovered", {}, (res) => {
        if (res && res.ok) {
            discovered = Array.isArray(res.devices) ? res.devices : [];
            renderDiscovered();
            updateScanStatus(res.lastScan);
        }
        const interval = parseInt($("#autoScanInterval").val(), 10) || 300;
        discoveredRefreshTimer = setTimeout(fetchDiscovered, Math.max(30, interval) * 1000);
    });
}

function updateScanStatus(lastScan) {
    if (lastScan) {
        const dt = new Date(lastScan);
        $("#scan-status").text(`${_("Last scan")}: ${dt.toLocaleString()}`);
    } else {
        $("#scan-status").text("");
    }
}

function getTableLabels() {
    return {
        name: _("Name"),
        ip: _("IP"),
        model: _("Model"),
        id: _("ID"),
        api: _("API"),
        foundVia: _("Found Via"),
        paired: _("Paired"),
        action: _("Action")
    };
}

function applyThemeFallback() {
    const $container = $("#adapter-container");
    if (!$container.length) return;

    if (!$container.hasClass("m")) {
        $container.addClass("m");
    }
    if (!$("body").hasClass("m")) {
        $("body").addClass("m");
    }

    const currentTheme = getCurrentThemeClass($container) || getCurrentThemeClass($("body"));
    const detectedTheme = detectTheme();

    if (detectedTheme !== currentTheme) {
        setThemeClass(detectedTheme);
    }
}

function setupThemeObserver() {
    if (themeObserverInitialized) return;
    themeObserverInitialized = true;

    try {
        const pdoc = window.parent && window.parent.document ? window.parent.document : null;
        if (pdoc && typeof MutationObserver !== "undefined") {
            const observer = new MutationObserver(() => applyThemeFallback());
            const targets = [];
            if (pdoc.documentElement) targets.push(pdoc.documentElement);
            if (pdoc.body && pdoc.body !== pdoc.documentElement) targets.push(pdoc.body);
            targets.forEach((t) =>
                observer.observe(t, {
                    attributes: true,
                    attributeFilter: ["class", "data-theme", "data-iob-theme", "data-color-scheme", "style"]
                })
            );
        }
    } catch (e) {
        // ignore
    }

    try {
        if (window.matchMedia) {
            const mq = window.matchMedia("(prefers-color-scheme: dark)");
            const handler = () => applyThemeFallback();
            if (mq.addEventListener) {
                mq.addEventListener("change", handler);
            } else if (mq.addListener) {
                mq.addListener(handler);
            }
        }
    } catch (e) {
        // ignore
    }
}

function getCurrentThemeClass($el) {
    if (!$el || !$el.length) return null;
    const classes = ["react-dark", "react-blue", "react-colored", "react-light"];
    for (const cls of classes) {
        if ($el.hasClass(cls)) return cls;
    }
    return null;
}

function setThemeClass(theme) {
    const classes = "react-dark react-blue react-colored react-light";
    const $container = $("#adapter-container");
    $container.removeClass(classes);
    $("body").removeClass(classes);

    if (theme) {
        $container.addClass(theme);
        $("body").addClass(theme);
    }
}

function detectTheme() {
    let theme = null;

    try {
        const params = new URLSearchParams(window.location.search || "");
        if (params.has("react")) theme = "react-" + params.get("react");
        if (!theme && params.has("theme")) theme = "react-" + params.get("theme");
        if (!theme && params.has("dark")) theme = "react-dark";
    } catch (e) {
        // ignore
    }

    if (!theme) {
        try {
            const pdoc = window.parent && window.parent.document ? window.parent.document : null;
            if (pdoc) {
                const bodyClass = (pdoc.body && pdoc.body.className) || "";
                const htmlClass = (pdoc.documentElement && pdoc.documentElement.className) || "";
                const dataTheme =
                    (pdoc.documentElement && pdoc.documentElement.getAttribute("data-theme")) ||
                    (pdoc.documentElement && pdoc.documentElement.getAttribute("data-iob-theme")) ||
                    (pdoc.body && pdoc.body.getAttribute("data-theme")) ||
                    (pdoc.body && pdoc.body.getAttribute("data-iob-theme")) ||
                    "";
                const combined = (bodyClass + " " + htmlClass + " " + dataTheme).toLowerCase();
                if (combined.includes("dark")) theme = "react-dark";
                else if (combined.includes("blue")) theme = "react-blue";
                else if (combined.includes("colored")) theme = "react-colored";
                else if (combined.includes("light")) theme = null;
            }
        } catch (e) {
            // ignore
        }
    }

    if (!theme) {
        const isDark = detectDarkByBackground();
        if (isDark) theme = "react-dark";
    }

    if (!theme && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
        theme = "react-dark";
    }

    return theme;
}

function detectDarkByBackground() {
    try {
        const pdoc = window.parent && window.parent.document ? window.parent.document : null;
        if (!pdoc) return false;
        const el = pdoc.body || pdoc.documentElement;
        if (!el || !window.parent.getComputedStyle) return false;
        const bg = window.parent.getComputedStyle(el).backgroundColor || "";
        const rgb = parseColor(bg);
        if (!rgb) return false;
        const luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
        return luminance < 128;
    } catch (e) {
        return false;
    }
}

function parseColor(color) {
    if (!color || typeof color !== "string") return null;
    const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (rgbMatch) {
        return {
            r: parseInt(rgbMatch[1], 10),
            g: parseInt(rgbMatch[2], 10),
            b: parseInt(rgbMatch[3], 10)
        };
    }
    const hexMatch = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hexMatch) {
        let hex = hexMatch[1];
        if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
        const num = parseInt(hex, 16);
        return {
            r: (num >> 16) & 255,
            g: (num >> 8) & 255,
            b: num & 255
        };
    }
    return null;
}

// Ensure required hooks are always available for adapter-settings.js
if (typeof window !== "undefined") {
    window.load = load;
    window.save = save;
}

function activateLabels() {
    $(".input-field input").each(function () {
        const $input = $(this);
        const $label = $input.siblings("label");
        if (!$label.length) return;
        const val = $input.val();
        if (val !== null && val !== undefined && String(val).length) {
            $label.addClass("active");
        } else {
            $label.removeClass("active");
        }
    });
}

function initSelects() {
    try {
        if (typeof M !== "undefined" && M.FormSelect) {
            M.FormSelect.init(document.querySelectorAll("select"));
        } else if ($ && $.fn && $.fn.formSelect) {
            $("select").formSelect();
        }
    } catch (e) {
        // ignore
    }
}
