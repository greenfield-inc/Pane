import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionWSLBridge, sessionWSLLauncher } from './sessionWSLBridge';
import { windowsPathToWSLMount } from '../utils/wslUtils';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pane's bridge "));
  directories.push(directory);
  fs.mkdirSync(path.join(directory, 'bin'));
  fs.writeFileSync(path.join(directory, 'bin', 'runpane.cjs'), `exports.main = async args => {
    const stdin = args.includes('--input-file') ? require('node:fs').readFileSync(0, 'utf8') : undefined;
    console.log(JSON.stringify({ args, stdin, session: process.env.PANE_ORCHESTRATION_SESSION_ID, panel: process.env.PANE_PANEL_ID, cwd: process.cwd() }));
    return 7;
  };`);
  const launcher = path.join(directory, 'launcher.cjs');
  fs.writeFileSync(launcher, sessionWSLLauncher(directory));
  return { directory, launcher };
}

describe('WSL Session RunPane bridge', () => {
  it('delivers JSON arguments unchanged to the bundled CLI and preserves its exit code', () => {
    const { directory, launcher } = fixture();
    const args = ['--summary', 'quotes " and \' $dollar `tick`; Unicode é', '--file', 'C:\\path with spaces\\'];
    const argsFile = path.join(directory, 'args.json');
    fs.writeFileSync(argsFile, JSON.stringify(args));
    try {
      execFileSync(process.execPath, [launcher], { env: { ...process.env, PANE_WSL_RUNPANE_ARGS_FILE: argsFile }, encoding: 'utf8' });
      throw new Error('Expected CLI exit code 7');
    } catch (error) {
      expect(error).toMatchObject({ status: 7 });
      // SAFETY: execFileSync errors with the asserted exit status include captured UTF-8 stdout.
      const output = (error as { stdout: string }).stdout;
      expect(JSON.parse(output).args).toEqual(args);
    }
  });

  it.skipIf(process.platform !== 'win32' || !process.env.PANE_TEST_WSL_DISTRO)('crosses actual WSL interop with literal arguments, paths, and the calling panel identity', () => {
    const { directory, launcher } = fixture();
    const record: OrchestrationSessionRecord = {
      id: 'session', internalSessionId: 'owner', name: 'Bridge test', agent: 'codex',
      runtime: 'wsl', wslDistribution: process.env.PANE_TEST_WSL_DISTRO,
      panelIds: { codex: 'saved-panel', claude: 'claude', cursor: 'cursor' },
      goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], associations: [], activity: [],
      revision: 1, createdAt: '2026-10-01', updatedAt: '2026-10-01',
    };
    const script = path.join(directory, 'runpane');
    fs.writeFileSync(script, sessionWSLBridge(directory, record, launcher));
    const literal = 'quotes " and \' $dollar `tick`; Unicode é' + 'x'.repeat(16_001);
    try {
      execFileSync('wsl.exe', ['-d', process.env.PANE_TEST_WSL_DISTRO!, '--exec', 'env', 'PANE_PANEL_ID=calling-panel', 'PATH=/usr/bin:/bin',
        'bash', windowsPathToWSLMount(script), '--summary', literal, '--file', windowsPathToWSLMount(script),
        '--input-file', '-', `--from-json=${windowsPathToWSLMount(script)}`, '--path', directory,
        `--pane-path=${windowsPathToWSLMount(launcher)}`, '--download-dir', 'relative downloads'],
      { input: 'piped input stays available', encoding: 'utf8', timeout: 30000 });
      throw new Error('Expected CLI exit code 7');
    } catch (error) {
      expect(error).toMatchObject({ status: 7 });
      // SAFETY: execFileSync errors with the asserted exit status include captured UTF-8 stdout.
      const output = JSON.parse((error as { stdout: string }).stdout);
      expect(output).toMatchObject({ session: 'session', panel: 'calling-panel', stdin: 'piped input stays available' });
      expect(output.args).toEqual(['--summary', literal, '--file', script, '--input-file', '-', `--from-json=${script}`, '--path', directory,
        `--pane-path=${launcher}`, '--download-dir', path.resolve('relative downloads'), '--pane-dir', directory]);
      expect(fs.readdirSync(directory).filter(name => name.startsWith('bridge-'))).toEqual([]);
    }
  });
});
