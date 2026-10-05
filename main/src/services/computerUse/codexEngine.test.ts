import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCodexEngine } from './codexEngine';
import type { CodexRuntime } from './codexRuntime';
import type { ComputerUseEngine } from './engine';

// A stand-in for OpenAI's launcher: a stdio MCP server whose `js` tool runs each cell against a fake
// `cua`. Like the real runtime, it asks the client to approve the app before every verb and refuses
// the verb unless the answer is accept. It logs getApp calls and approval answers.
const FAKE_LAUNCHER = `
const fs = require('fs');
const vm = require('vm');
const log = (entry) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\\n');
let out = '';
let images = [];
let nextId = 1000;
const waiting = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const approve = (app) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { message: 'Allow?', _meta: { connector_id: 'computer-use', tool_params: { app } } } });
});
const states = { TextEdit: ['full tree v1', 'diff: ~ 2 text entry area Value: hi'] };
function makeApp(name) {
  const gate = async (verb) => {
    const answer = await approve(name);
    log({ approval: answer.action, app: name, verb });
    if (answer.action !== 'accept') throw new Error('Computer Use was not approved for ' + name);
  };
  return {
    async getAXState() { await gate('get_app_state'); return states[name].shift() ?? 'no change'; },
    async getScreenshot() { await gate('screenshot'); return new Uint8Array([255, 216, 255, 224]); },
    async typeText(text) { await gate('type_text'); log({ typed: text, app: name }); },
    async click() { await gate('click'); throw new Error('Element 99 does not exist'); },
  };
}
const context = vm.createContext({
  JSON, Map, Error, String,
  cua: {
    async getApp(ref) {
      log({ getApp: ref });
      if (ref === 'Terminal') throw new Error("Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.");
      return makeApp(ref);
    },
    async listApps() { return [{ id: 'com.apple.TextEdit', displayName: 'TextEdit' }]; },
  },
  nodeRepl: {
    write(text) { out += text; },
    async emitImage(bytes) { images.push({ type: 'image', mimeType: 'image/jpeg', data: Buffer.from(bytes).toString('base64') }); },
  },
});
let buffer = '';
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === undefined) { waiting.get(message.id)?.(message.result); waiting.delete(message.id); continue; }
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'fake' }, capabilities: {} } });
    if (message.method === 'tools/call') {
      out = 'Documentation the runtime prints on first use.\\n';
      images = [];
      if (process.env.FAKE_CRASH_ONCE && fs.existsSync(process.env.FAKE_CRASH_ONCE)) { fs.rmSync(process.env.FAKE_CRASH_ONCE); process.exit(3); }
      await vm.runInContext('(async () => {' + message.params.arguments.code + '})()', context);
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: out }, ...images] } });
    }
  }
});
`;

/** One line of the fake launcher's log. */
interface LogEntry {
  getApp?: string;
  approval?: string;
  typed?: string;
  app?: string;
  verb?: string;
}

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('Codex engine', () => {
  let dir: string;
  let logFile: string;
  let engine: ComputerUseEngine;

  function runtime(platform: NodeJS.Platform): CodexRuntime {
    const launcher = path.join(dir, 'cua-repl.mjs');
    fs.writeFileSync(launcher.replace(/\.mjs$/, '.cjs'), FAKE_LAUNCHER);
    fs.writeFileSync(launcher, `import './cua-repl.cjs';\n`);
    return { platform, resources: dir, node: process.execPath, nodeRepl: '', moduleDir: dir, launcher, codexCli: '' };
  }

  function useEngine(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}): void {
    const found = runtime(platform);
    engine = createCodexEngine({ locate: async () => ({ found: true, runtime: found }), env: { ...env, FAKE_LOG: logFile, DISPLAY: ':0' } });
  }

  function logged(): LogEntry[] {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-engine-'));
    logFile = path.join(dir, 'log.jsonl');
  });

  afterEach(async () => {
    await engine?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads an app through the runtime and answers its approval prompt itself', async () => {
    useEngine('linux');

    const first = await engine.call('get_app_state', { app: 'TextEdit' });
    const second = await engine.call('get_app_state', { app: 'TextEdit' });

    expect(first).toEqual({ ok: true, data: { state: 'full tree v1' } });
    expect(second).toEqual({ ok: true, data: { state: 'diff: ~ 2 text entry area Value: hi' } });
    expect(logged().filter((entry) => 'getApp' in entry)).toEqual([{ getApp: 'TextEdit' }]);
    expect(logged().filter((entry) => 'approval' in entry).map((entry) => entry.approval)).toEqual(['accept', 'accept']);
  });

  it('passes text through unchanged, quotes included', async () => {
    useEngine('linux');
    const text = `He said "hi" \\ then ${'`'}left${'`'}\nnext line`;

    await expect(engine.call('type_text', { app: 'TextEdit', text })).resolves.toEqual({ ok: true, data: {} });
    expect(logged().find((entry) => 'typed' in entry)).toEqual({ typed: text, app: 'TextEdit' });
  });

  it('returns screenshots as images', async () => {
    useEngine('linux');
    await expect(engine.call('screenshot', { app: 'TextEdit' })).resolves.toEqual({
      ok: true,
      data: {},
      images: [{ mime: 'image/jpeg', base64: Buffer.from([255, 216, 255, 224]).toString('base64') }],
    });
  });

  it("reports the runtime's own refusal and errors as failed calls", async () => {
    useEngine('linux');
    await expect(engine.call('get_app_state', { app: 'Terminal' })).resolves.toEqual({
      ok: false,
      error: { code: 'codex_error', message: "Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons." },
    });
    await expect(engine.call('click', { app: 'TextEdit', element_index: 99 })).resolves.toEqual({
      ok: false,
      error: { code: 'codex_error', message: 'Element 99 does not exist' },
    });
    await expect(engine.call('teleport', {})).resolves.toMatchObject({ ok: false, error: { code: 'unknown_tool' } });
  });

  it('says when input on Windows brought the window forward', async () => {
    useEngine('win32');
    await expect(engine.call('type_text', { app: 'TextEdit', text: 'x' })).resolves.toEqual({ ok: true, data: { broughtForward: true } });
    await expect(engine.call('get_app_state', { app: 'TextEdit' })).resolves.toEqual({ ok: true, data: { state: 'full tree v1' } });
  });

  it('fails the call when the runtime exits, and starts it again on the next call', async () => {
    const crashFlag = path.join(dir, 'crash-once');
    fs.writeFileSync(crashFlag, '');
    useEngine('linux', { FAKE_CRASH_ONCE: crashFlag });
    const crashed = await engine.call('list_apps', {});
    expect(crashed.ok).toBe(false);
    expect(crashed.error?.message).toMatch(/exited/);

    await expect(engine.call('list_apps', {})).resolves.toEqual({ ok: true, data: { apps: [{ id: 'com.apple.TextEdit', displayName: 'TextEdit' }] } });
  });

  it('reports not installed, with the reason, when ChatGPT is missing', async () => {
    engine = createCodexEngine({ locate: async () => ({ found: false, reason: 'ChatGPT is not installed.' }) });
    await expect(engine.status()).resolves.toMatchObject({ installed: false, detail: 'ChatGPT is not installed.' });
    await expect(engine.call('list_apps', {})).resolves.toEqual({
      ok: false,
      error: { code: 'engine_unavailable', message: 'ChatGPT is not installed.' },
    });
  });
});
