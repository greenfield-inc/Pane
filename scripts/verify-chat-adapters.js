#!/usr/bin/env node

/**
 * Release-path guard for chat tabs. Pane bundles its pinned ACP adapters
 * (main/src/services/agentChat/adapterSetup.ts) and runs them with the packaged
 * Electron binary as Node. Each packaged app under dist-electron must:
 *   1. carry both adapters inside app.asar,
 *   2. carry none of the native agent binaries their SDKs bundle (Pane runs the
 *      person's own claude and codex instead), and
 *   3. start each adapter the way Pane does and complete ACP `initialize`.
 * Step 3 runs only for apps this machine can execute (same OS and arch).
 * scripts/after-pack.js runs it for every packed app, before signing or
 * publishing; run it by hand on a dist-electron folder too.
 *
 * Background: Pane once installed the adapter at first use with the npm it
 * shipped, but electron-builder dropped npm's nested node_modules, so chat
 * failed on every fresh install while the build itself looked fine.
 *
 * Usage: node scripts/verify-chat-adapters.js [dist-electron-dir]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const asar = require('@electron/asar');

const ADAPTERS = [
  { packageName: '@agentclientprotocol/claude-agent-acp', env: 'CLAUDE_CODE_EXECUTABLE' },
  { packageName: '@agentclientprotocol/codex-acp', env: 'CODEX_PATH' },
];
const FORBIDDEN = [/\/node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+\//, /\/node_modules\/@openai\/codex-[^/]+\//];
const INITIALIZE_TIMEOUT_MS = 30_000;
// codex-acp starts `codex app-server` before it answers initialize. This stand-in
// answers every request, which is all initialize needs; no real agent runs.
const STUB_APP_SERVER = "let b='';process.stdin.on('data',c=>{b+=c;let e;while((e=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,e));b=b.slice(e+1);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');}});";

/** A stand-in agent CLI: the adapters need a path, and initialize never runs a real agent. */
function stubAgentCli() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-verify-chat-'));
  const script = path.join(dir, 'app-server.js');
  fs.writeFileSync(script, STUB_APP_SERVER);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'codex.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
    return { dir, executable: path.join(dir, 'codex.cmd') };
  }
  fs.writeFileSync(path.join(dir, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return { dir, executable: path.join(dir, 'codex') };
}

/** Starts the adapter as Pane does (Electron as Node, entry inside app.asar) and completes ACP initialize. */
function initialize(app, adapter, entry, cli) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', [adapter.env]: cli };
    const child = spawn(app.executable, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no initialize response within ${INITIALIZE_TIMEOUT_MS / 1000}s. stderr: ${stderr.slice(-2000)}`)); }, INITIALIZE_TIMEOUT_MS);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`exited with ${code} before answering initialize. stderr: ${stderr.slice(-2000)}`)); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      for (let end = stdout.indexOf('\n'); end >= 0; end = stdout.indexOf('\n')) {
        const line = stdout.slice(0, end);
        stdout = stdout.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 1) continue;
        clearTimeout(timer);
        child.removeAllListeners('exit');
        child.kill();
        if (message.error || !Number.isInteger(message.result?.protocolVersion)) reject(new Error(`initialize failed: ${JSON.stringify(message.error ?? message.result)}`));
        else resolve(message.result);
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`);
  });
}

/** The packed app in an electron-builder appOutDir: its app.asar and the Electron executable beside it. */
function packedApp(appOutDir, platform) {
  if (platform === 'darwin') {
    const bundle = fs.readdirSync(appOutDir).find(name => name.endsWith('.app'));
    if (!bundle) throw new Error(`No .app bundle in ${appOutDir}.`);
    const dir = path.join(appOutDir, bundle);
    return { dir, asar: path.join(dir, 'Contents', 'Resources', 'app.asar'), executable: path.join(dir, 'Contents', 'MacOS', path.basename(bundle, '.app')) };
  }
  return { dir: appOutDir, asar: path.join(appOutDir, 'resources', 'app.asar'), executable: path.join(appOutDir, platform === 'win32' ? 'Pane.exe' : 'pane') };
}

/**
 * Checks one packed app. `arch` is the Node arch name (x64, arm64, universal).
 * Throws with what is wrong and where to look; resolves with a log line per adapter.
 */
async function verifyChatAdapters(appOutDir, platform, arch) {
  const app = packedApp(appOutDir, platform);
  const files = asar.listPackage(app.asar).map(file => file.replace(/\\/g, '/'));
  const forbidden = files.filter(file => FORBIDDEN.some(pattern => pattern.test(file)));
  if (forbidden.length) throw new Error(`${app.asar} carries native agent binaries the chat adapters never use, for example ${forbidden[0]}. Check the build.files exclusions in package.json and ignoredOptionalDependencies in pnpm-workspace.yaml.`);
  const runnable = platform === process.platform && (arch === process.arch || arch === 'universal');
  const lines = [];
  const stub = stubAgentCli();
  try {
    for (const adapter of ADAPTERS) {
      const manifest = `/node_modules/${adapter.packageName}/package.json`;
      if (!files.includes(manifest)) throw new Error(`${app.asar} is missing ${adapter.packageName}, so chat tabs would fail on every install. Check it is a dependency in package.json.`);
      const { version } = JSON.parse(asar.extractFile(app.asar, path.join('node_modules', ...adapter.packageName.split('/'), 'package.json')).toString('utf8'));
      if (!runnable) { lines.push(`${adapter.packageName}@${version} present (not started: built for ${platform}-${arch})`); continue; }
      const entry = path.join(app.asar, 'node_modules', ...adapter.packageName.split('/'), 'dist', 'index.js');
      try {
        const result = await initialize(app, adapter, entry, stub.executable);
        lines.push(`${adapter.packageName}@${version} answered ACP initialize (protocol ${result.protocolVersion})`);
      } catch (error) {
        throw new Error(`${adapter.packageName}@${version} did not start from ${app.asar}: ${error.message}`);
      }
    }
  } finally { fs.rmSync(stub.dir, { recursive: true, force: true }); }
  for (const line of lines) console.log(`[verify-chat-adapters] ${path.basename(appOutDir)}: ${line}`);
  return lines;
}

/** CLI: every electron-builder output folder under dist-electron. */
async function main() {
  const distDir = path.resolve(process.argv[2] || path.join(process.cwd(), 'dist-electron'));
  const outputs = fs.readdirSync(distDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    .map(name => ({ name, platform: name.startsWith('mac') ? 'darwin' : name.startsWith('linux') ? 'linux' : name.startsWith('win') ? 'win32' : undefined }))
    .filter(output => output.platform && (output.platform === 'darwin' || output.name.endsWith('-unpacked')));
  if (outputs.length === 0) throw new Error(`No packaged app under ${distDir}.`);
  for (const output of outputs) await verifyChatAdapters(path.join(distDir, output.name), output.platform, /(arm64|universal)/.exec(output.name)?.[1] ?? 'x64');
  console.log(`[verify-chat-adapters] OK: ${outputs.length} packaged app(s) checked.`);
}

if (require.main === module) main().catch(error => { console.error(`[verify-chat-adapters] ${error.message}`); process.exit(1); });

module.exports = { verifyChatAdapters };
