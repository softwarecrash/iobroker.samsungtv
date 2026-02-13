'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function fileExists(p) {
    try {
        return fs.existsSync(p);
    } catch (e) {
        return false;
    }
}

function findIoBrokerCommand() {
    const envHome = process.env.IOBROKER_HOME;
    const candidates = [];

    if (envHome) {
        candidates.push(path.join(envHome, 'iobroker'));
        candidates.push(path.join(envHome, 'node_modules', 'iobroker.js-controller', 'iobroker.js'));
    }

    candidates.push('/opt/iobroker/iobroker');
    candidates.push('/usr/local/bin/iobroker');
    candidates.push('/usr/bin/iobroker');

    for (const candidate of candidates) {
        if (fileExists(candidate)) {
            if (candidate.endsWith('.js')) {
                return { cmd: process.execPath, args: [candidate] };
            }
            return { cmd: candidate, args: [] };
        }
    }

    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
        const shellCandidate = path.join(dir, 'iobroker');
        if (fileExists(shellCandidate)) {
            return { cmd: shellCandidate, args: [] };
        }

        const jsCandidate = path.join(dir, 'node_modules', 'iobroker.js-controller', 'iobroker.js');
        if (fileExists(jsCandidate)) {
            return { cmd: process.execPath, args: [jsCandidate] };
        }

        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }

    return { cmd: 'iobroker', args: [] };
}

function execIoBroker(args) {
    const cmd = findIoBrokerCommand();
    execFileSync(cmd.cmd, [...cmd.args, ...args], { stdio: 'ignore' });
}

function hasInstance() {
    try {
        execIoBroker(['object', 'get', 'system.adapter.samsungtv.0']);
        return true;
    } catch (e) {
        return false;
    }
}

function addInstance() {
    try {
        execIoBroker(['add', 'samsungtv']);
    } catch (e) {
        // ignore if already exists or not possible in this environment
    }
}

if (!process.env.IOBROKER_SKIP_POSTINSTALL) {
    if (!hasInstance()) {
        addInstance();
    }
}
