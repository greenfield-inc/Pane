import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { listOwnAgentFarmProfiles, parseOwnAgentFarmProfiles } from './ownAgentFarm';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the person's own agent-farm: prints one profile for `profiles list`, fails otherwise. */
function fakeOwnCli(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pane-own-agent-farm-'));
  temporary.push(dir);
  const script = path.join(dir, 'cli.cjs');
  writeFileSync(script, "if (process.argv[2] === 'profiles' && process.argv[3] === 'list') console.log('team/helper -> helper | plugin team 1.0.0 | claude | claude-opus-5-5 high | native default'); else { console.error('unexpected ' + process.argv.slice(2).join(' ')); process.exit(2); }\n");
  if (process.platform === 'win32') {
    const shim = path.join(dir, 'agent-farm.cmd');
    writeFileSync(shim, `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return shim;
  }
  const shim = path.join(dir, 'agent-farm');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return shim;
}

describe('parseOwnAgentFarmProfiles', () => {
  it('reads plugin and local profiles from agent-farm profiles list', () => {
    const stdout = [
      'greenfield/planner (claude: claude-opus-5-5 high · codex: gpt-6-astra high) -> planner [ambiguous bare name] | plugin greenfield 0.0.46 | claude | claude-opus-5-5 high | native default',
      'greenfield/product-researcher (astra: gpt-6-astra high fast · opus: claude-opus-5-5 high) -> astra-researcher | plugin greenfield 0.0.46 | codex | gpt-6-astra high | fast',
      'my-helper -> helper | local | claude | claude-sonnet-5-5 low | native default',
      '',
      'Some trailing note without fields',
    ].join('\n');
    expect(parseOwnAgentFarmProfiles(stdout)).toEqual([
      { name: 'greenfield/planner', source: 'plugin greenfield 0.0.46', harness: 'claude', model: 'claude-opus-5-5 high' },
      { name: 'greenfield/product-researcher', source: 'plugin greenfield 0.0.46', harness: 'codex', model: 'gpt-6-astra high' },
      { name: 'my-helper', source: 'local', harness: 'claude', model: 'claude-sonnet-5-5 low' },
    ]);
  });
});

describe('listOwnAgentFarmProfiles', () => {
  it('runs only `profiles list` with the person\'s own CLI, passing no config root', async () => {
    expect(await listOwnAgentFarmProfiles(fakeOwnCli())).toEqual([{ name: 'team/helper', source: 'plugin team 1.0.0', harness: 'claude', model: 'claude-opus-5-5 high' }]);
  });

  it('names the CLI and the next step when it fails', async () => {
    await expect(listOwnAgentFarmProfiles(path.join(tmpdir(), 'no-such-agent-farm'))).rejects.toMatchObject({ code: 'AGENT_FARM_LIST_FAILED', next: expect.stringContaining('agent-farm profiles list') });
  });
});
