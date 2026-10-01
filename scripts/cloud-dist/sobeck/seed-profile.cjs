#!/usr/bin/env node
// Saves the remote host from a pane-remote:// connection code as a desktop profile, the same record
// Settings > Remote Access > Connections > Import & Connect saves, without opening the app. The code is
// read from a file and never printed: only the host's label and address are.
//
// No dependencies, so the Pane binary can run it as Node:
//   ELECTRON_RUN_AS_NODE=1 Pane.exe seed-profile.cjs <pairing file> <Pane data dir>
//
// The data dir must not be the installed Pane's (~/.pane). The profile is upserted by address into
// <data dir>/config.json under remoteDaemon.client.profiles; everything else in the file is kept.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [pairingFile, dataDirArg] = process.argv.slice(2);
if (!pairingFile || !dataDirArg) {
  console.error('usage: seed-profile.cjs <pairing file> <Pane data dir>');
  process.exit(2);
}
const dataDir = path.resolve(dataDirArg);
if (dataDir.toLowerCase() === path.join(os.homedir(), '.pane').toLowerCase()) {
  console.error('seed-profile: refusing to write the installed Pane data dir (~/.pane)');
  process.exit(2);
}

function fail(message) {
  // Never include the code or any part of it.
  console.error(`seed-profile: ${message}`);
  process.exit(1);
}

const nonEmpty = (value) => Object.prototype.toString.call(value) === '[object String]' && value.trim().length > 0;

const code = fs.readFileSync(pairingFile, 'utf8').trim();
if (!code.startsWith('pane-remote://')) fail(`${pairingFile} does not hold a pane-remote:// code`);
let payload;
try {
  payload = JSON.parse(Buffer.from(code.slice('pane-remote://'.length), 'base64url').toString('utf8'));
} catch {
  fail('the connection code is not valid');
}
if (!payload || payload.v !== 1 || !nonEmpty(payload.label) || !nonEmpty(payload.baseUrl) || !nonEmpty(payload.token)
  || payload.transport !== 'http+sse') {
  fail('the connection code is not a version 1 http+sse code');
}
const baseUrl = payload.baseUrl.trim().replace(/\/+$/, '');
let origin;
try {
  origin = new URL(baseUrl).origin;
} catch {
  fail('the connection code has no valid address');
}

const configPath = path.join(dataDir, 'config.json');
let config = {};
let mode = 0o600;
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  mode = fs.statSync(configPath).mode & 0o777;
}
const remoteDaemon = config.remoteDaemon ?? {};
const client = remoteDaemon.client ?? {};
const profiles = Array.isArray(client.profiles) ? client.profiles : [];
const index = profiles.findIndex((profile) => profile && profile.baseUrl === baseUrl);
const profile = {
  id: index === -1 ? crypto.randomUUID() : profiles[index].id,
  label: payload.label.trim(),
  baseUrl,
  token: payload.token,
  transport: 'http+sse',
};
if (payload.tunnel) profile.tunnel = payload.tunnel;
if (index === -1) profiles.push(profile); else profiles[index] = profile;

const next = {
  ...config,
  remoteDaemon: {
    ...remoteDaemon,
    client: { ...client, profiles, activeProfileId: client.activeProfileId ?? null, mode: client.mode ?? 'local' },
  },
};
fs.mkdirSync(dataDir, { recursive: true });
const tmp = `${configPath}.seed.${crypto.randomBytes(4).toString('hex')}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
fs.renameSync(tmp, configPath);
console.log(`seed-profile: ${index === -1 ? 'added' : 'updated'} host "${profile.label}" at ${origin} in ${configPath}`);
