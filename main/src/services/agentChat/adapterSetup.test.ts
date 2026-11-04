import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { adapterEntry, CODEX_ADAPTER_VERSION, compareVersions, installAdapter } from './adapterSetup';

let directory = '';
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'pane-adapter-cli-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

/** A POSIX stand-in for the person's CLI that prints `version` and counts its runs. */
function fakeCli(name: string, version: string): string {
  const executable = path.join(directory, name);
  writeFileSync(executable, `#!/bin/sh\necho run >> "${executable}.runs"\necho "${version}"\n`, { mode: 0o700 });
  return executable;
}
const runs = (executable: string) => readFileSync(`${executable}.runs`, 'utf8').trim().split('\n').length;

it('resolves both bundled adapters at their pinned versions, with no download folder', () => {
  expect(adapterEntry('claude')).toMatch(/claude-agent-acp[/\\]dist[/\\]index\.js$/);
  const codex = adapterEntry('codex')!;
  expect(codex).toMatch(/codex-acp[/\\]dist[/\\]index\.js$/);
  expect(JSON.parse(readFileSync(path.join(codex, '..', '..', 'package.json'), 'utf8'))).toMatchObject({ version: CODEX_ADAPTER_VERSION });
});

it.skipIf(process.platform === 'win32').each(['claude', 'codex'] as const)('starts the bundled %s adapter and completes ACP initialize', async provider => {
  // codex-acp starts `codex app-server` first; this stand-in answers every request.
  const appServer = path.join(directory, 'app-server.js');
  writeFileSync(appServer, "let b='';process.stdin.on('data',c=>{b+=c;let e;while((e=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,e));b=b.slice(e+1);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');}});");
  const codex = path.join(directory, 'codex');
  writeFileSync(codex, `#!/bin/sh\nexec "${process.execPath}" "${appServer}" "$@"\n`, { mode: 0o700 });
  const child = spawn(process.execPath, [adapterEntry(provider)!], { env: { ...process.env, CLAUDE_CODE_EXECUTABLE: '/missing', CODEX_PATH: codex }, stdio: 'pipe' });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`);
    const line = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      child.stdout.on('data', chunk => { buffer += chunk; const end = buffer.indexOf('\n'); if (end >= 0) resolve(buffer.slice(0, end)); });
      child.on('exit', code => reject(new Error(`adapter exited with ${code}`)));
    });
    expect(JSON.parse(line)).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
  } finally { child.kill(); }
}, 30_000);

it('tells the person how to install a missing CLI', async () => {
  await expect(installAdapter('codex', null)).rejects.toMatchObject({ code: 'CHAT_AGENT_NOT_INSTALLED', next: expect.stringContaining('npm install -g @openai/codex@latest') });
});

it.skipIf(process.platform === 'win32')('rejects a CLI older than the adapter needs with the upgrade command', async () => {
  const executable = fakeCli('claude', '2.1.315 (Claude Code)');
  await expect(installAdapter('claude', executable)).rejects.toMatchObject({
    code: 'CHAT_AGENT_OUTDATED', message: expect.stringContaining('2.1.315'), next: expect.stringContaining('npm install -g @anthropic-ai/claude-code@latest'),
  });
});

it.skipIf(process.platform === 'win32')('accepts a CLI at the minimum version and checks it once', async () => {
  const executable = fakeCli('codex', 'codex-cli 0.165.0');
  await installAdapter('codex', executable);
  await installAdapter('codex', executable);
  expect(runs(executable)).toBe(1);
});

it.skipIf(process.platform === 'win32')('checks the CLI from the tab\'s project folder and environment', async () => {
  // A project-selected wrapper that only answers from its project with its launch environment.
  const project = mkdtempSync(path.join(directory, 'project-'));
  writeFileSync(path.join(project, '.claude-version'), '2.1.318 (Claude Code)');
  const executable = path.join(directory, 'claude-wrapper');
  writeFileSync(executable, '#!/bin/sh\n[ "$PANE_WRAPPER" = on ] && cat .claude-version || exit 3\n', { mode: 0o700 });
  await expect(installAdapter('claude', executable, { cwd: project, env: { ...process.env, PANE_WRAPPER: 'on' } })).resolves.toBeUndefined();
});

it('reports a CLI that cannot run as unreadable, with the reason, not as outdated', async () => {
  const missing = path.join(directory, 'deleted-claude');
  await expect(installAdapter('claude', missing)).rejects.toMatchObject({
    code: 'CHAT_AGENT_VERSION_UNREADABLE', message: expect.stringContaining('ENOENT'), next: expect.stringContaining(`${missing} --version`),
  });
});

it.skipIf(process.platform === 'win32')('reports a CLI that prints no version as unreadable', async () => {
  const executable = fakeCli('codex', 'usage: codex [options]');
  await expect(installAdapter('codex', executable)).rejects.toMatchObject({ code: 'CHAT_AGENT_VERSION_UNREADABLE', message: expect.stringContaining('usage: codex') });
});

it('compares dotted versions numerically', () => {
  expect(compareVersions('2.1.316', '2.1.316')).toBe(0);
  expect(compareVersions('2.1.40', '2.1.316')).toBeLessThan(0);
  expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
});
