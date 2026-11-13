import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from './agentRegistry';

const URL_BASE = 'https://registry.test/v1/latest/';
const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pane-agent-registry-'));
  cleanup.push(dir);
  return dir;
}

/** A tar.gz holding `bin/<name>`, a script that prints its version. Returns its bytes and sha256. */
function archive(name: string, version: string) {
  const dir = scratch();
  mkdirSync(path.join(dir, 'pkg', 'bin'), { recursive: true });
  writeFileSync(path.join(dir, 'pkg', 'bin', name), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  execFileSync('tar', ['-czf', path.join(dir, 'a.tar.gz'), '-C', path.join(dir, 'pkg'), 'bin']);
  const bytes = readFileSync(path.join(dir, 'a.tar.gz'));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** A stand-in npm: `install --prefix <dir> ... <spec>` writes the package with a bin script. */
function fakeNpm(dir: string): string {
  const npm = path.join(dir, 'npm');
  writeFileSync(npm, `#!/bin/sh
prefix=""; spec=""
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift;; -*) ;; *) spec="$1";; esac; shift; done
name="\${spec%@*}"
mkdir -p "$prefix/node_modules/$name/bin"
echo '{"name":"'"$name"'","bin":{"helper":"bin/helper.js"}}' > "$prefix/node_modules/$name/package.json"
echo 'console.log("helper")' > "$prefix/node_modules/$name/bin/helper.js"
`, { mode: 0o755 });
  return npm;
}

const KEY = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;

/** Serves `files` by URL, as the registry and download hosts would. */
function serve(files: Map<string, Buffer | string>): typeof fetch {
  const fake = async (input: string | URL | Request) => {
    const body = files.get(input.toString());
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
  };
  // SAFETY: the registry only calls fetch(url, { signal }) and reads ok, status, body and text().
  return fake as typeof fetch;
}

const TAR = execFileSync('sh', ['-c', 'command -v tar']).toString().trim();

function registry(files: Map<string, Buffer | string>, root = scratch(), tools: Record<string, string> = {}, hidden: string[] = [], now?: () => number) {
  const lookup = (name: string) => tools[name] ?? (name === 'tar' ? TAR : null);
  return new AgentRegistry({ root, url: `${URL_BASE}registry.json`, hidden: () => new Set(hidden), findExecutable: lookup, fetch: serve(files), now });
}

function index(agents: object[]): string { return JSON.stringify({ version: '1.0.0', agents, extensions: [] }); }
function binaryEntry(id: string, version: string, archiveUrl: string, sha256?: string) {
  const unchecked = { archive: archiveUrl, cmd: `./bin/${id}`, args: ['acp'] };
  const target = sha256 ? { ...unchecked, sha256 } : unchecked;
  return { id, name: id.toUpperCase(), version, description: `${id} agent`, distribution: { binary: { [KEY]: target } } };
}

describe.skipIf(process.platform === 'win32')('installing agents from the ACP Registry (C3)', () => {
  it('installs a checksummed binary into a version folder and starts it with the registry args', async () => {
    const goose = archive('goose', '1.0.0');
    const files = new Map<string, Buffer | string>([[`${URL_BASE}registry.json`, index([binaryEntry('goose', '1.0.0', 'https://dl.test/goose.tar.gz', goose.sha256)])], ['https://dl.test/goose.tar.gz', goose.bytes]]);
    const agents = registry(files);
    expect((await agents.list()).agents).toEqual([expect.objectContaining({ id: 'goose', kind: 'binary', verified: true, iconUrl: `${URL_BASE}goose.svg` })]);
    await agents.install('goose');
    const run = await agents.resolve('goose');
    expect(run?.args).toEqual(['acp']);
    expect(execFileSync(run!.executable).toString().trim()).toBe('1.0.0');
    expect((await agents.list()).agents[0].installedVersion).toBe('1.0.0');
  });

  it('asks before installing a binary with no checksum, and records that it is unverified', async () => {
    const tool = archive('nochk', '2.0.0');
    const files = new Map<string, Buffer | string>([[`${URL_BASE}registry.json`, index([binaryEntry('nochk', '2.0.0', 'https://dl.test/nochk.tar.gz')])], ['https://dl.test/nochk.tar.gz', tool.bytes]]);
    const agents = registry(files);
    expect((await agents.list()).agents[0].verified).toBe(false);
    await expect(agents.install('nochk')).rejects.toMatchObject({ code: 'AGENT_REGISTRY_UNVERIFIED' });
    expect(agents.installed()).toEqual([]);
    await expect(agents.install('nochk', { allowUnverified: true })).resolves.toMatchObject({ verified: false });
  });

  it('refuses a download whose checksum does not match, leaving nothing installed', async () => {
    const real = archive('bad', '1.0.0');
    const files = new Map<string, Buffer | string>([[`${URL_BASE}registry.json`, index([binaryEntry('bad', '1.0.0', 'https://dl.test/bad.tar.gz', '0'.repeat(64))])], ['https://dl.test/bad.tar.gz', real.bytes]]);
    const agents = registry(files);
    await expect(agents.install('bad')).rejects.toMatchObject({ code: 'AGENT_REGISTRY_CHECKSUM_MISMATCH' });
    expect(agents.installed()).toEqual([]);
    expect(await agents.resolve('bad')).toBeUndefined();
  });

  it('installs an npm agent with the person\'s npm and runs it with their Node.js, and says when npm is missing', async () => {
    const tools = scratch();
    const entry = { id: 'gemini', name: 'Gemini CLI', version: '0.9.0', distribution: { npx: { package: '@google/gemini-cli@0.9.0', args: ['--experimental-acp'] } } };
    const files = new Map<string, Buffer | string>([[`${URL_BASE}registry.json`, index([entry])]]);
    expect((await registry(files).list()).agents[0]).toMatchObject({ kind: 'npx', needs: 'Node.js' });
    const agents = registry(files, scratch(), { npm: fakeNpm(tools), node: '/usr/bin/env-node' });
    await agents.install('gemini');
    const run = await agents.resolve('gemini');
    expect(run?.executable).toBe('/usr/bin/env-node');
    expect(run?.args[0]).toMatch(/node_modules[/\\]@google[/\\]gemini-cli[/\\]bin[/\\]helper\.js$/);
    expect(run?.args.slice(1)).toEqual(['--experimental-acp']);
  });

  it('lists neither uvx-only agents nor ones a configured agent covers, and skips a malformed entry', async () => {
    const files = new Map<string, Buffer | string>([[`${URL_BASE}registry.json`, index([
      { id: 'pyagent', name: 'Py', version: '1.0.0', distribution: { uvx: { package: 'pyagent' } } },
      { id: 'covered', name: 'Covered', version: '1.0.0', distribution: { npx: { package: 'covered' } } },
      { id: 'Bad Id', name: 'Broken', version: '1.0.0', distribution: {} },
      { id: 'kept', name: 'Kept', version: '1.0.0', distribution: { npx: { package: 'kept' } } },
    ])]]);
    expect((await registry(files, scratch(), {}, ['covered']).list()).agents.map(agent => agent.id)).toEqual(['kept']);
  });

  it('moves an installed agent to the registry\'s new version on its next launch and then drops the old folder (D-15)', async () => {
    const root = scratch();
    const v1 = archive('goose', '1.0.0');
    const v2 = archive('goose', '1.1.0');
    const files = new Map<string, Buffer | string>([[`${URL_BASE}registry.json`, index([binaryEntry('goose', '1.0.0', 'https://dl.test/goose-1.tar.gz', v1.sha256)])], ['https://dl.test/goose-1.tar.gz', v1.bytes], ['https://dl.test/goose-2.tar.gz', v2.bytes]]);
    await registry(files, root).install('goose');
    files.set(`${URL_BASE}registry.json`, index([binaryEntry('goose', '1.1.0', 'https://dl.test/goose-2.tar.gz', v2.sha256)]));
    // A new Pane run reads the index again (its cache is older than an hour on a fresh instance's clock).
    const later = registry(files, root, {}, [], () => Date.now() + 2 * 60 * 60 * 1000);
    const run = await later.resolve('goose');
    expect(execFileSync(run!.executable).toString().trim()).toBe('1.1.0');
    later.removeOlderVersions('goose', '1.1.0');
    expect(existsSync(path.join(root, 'agents', 'goose', '1.0.0'))).toBe(false);
    expect(existsSync(path.join(root, 'agents', 'goose', '1.1.0'))).toBe(true);
  });
});
