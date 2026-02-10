"use strict";

const { execFileSync } = require("child_process");

function hasInstance() {
    try {
        execFileSync("iobroker", ["object", "get", "system.adapter.samsungtv.0"], { stdio: "ignore" });
        return true;
    } catch (e) {
        return false;
    }
}

function addInstance() {
    try {
        execFileSync("iobroker", ["add", "samsungtv"], { stdio: "ignore" });
    } catch (e) {
        // ignore if already exists or not possible in this environment
    }
}

if (!process.env.IOBROKER_SKIP_POSTINSTALL) {
    if (!hasInstance()) {
        addInstance();
    }
}
