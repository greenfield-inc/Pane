import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTIFY_SETTINGS } from '../../../../shared/types/notify';
import { NotifyQueue } from '../notify/notifyQueue';
import { ClaudePromptBridge } from './claudePromptBridge';
import { setClaudePromptBridge, withClaudePromptHooks } from '.';

describe('withClaudePromptHooks', () => {
  let appDirectory: string;
  let bridge: ClaudePromptBridge;

  beforeEach(async () => {
    appDirectory = mkdtempSync(path.join(os.tmpdir(), 'pane-claude-prompts-'));
    vi.stubEnv('PANE_DIR', appDirectory);
    const queue = new NotifyQueue({ settings: () => DEFAULT_NOTIFY_SETTINGS, showOutsideSupported: true, shortcutRegistered: () => true, instructionFiles: () => [] });
    bridge = new ClaudePromptBridge({ queue, tab: () => undefined, enabled: () => true, hookTimeoutSeconds: 600 });
    await bridge.start();
    setClaudePromptBridge(bridge);
  });
  afterEach(async () => {
    setClaudePromptBridge(undefined);
    await bridge.stop();
    vi.unstubAllEnvs();
  });

  it("writes Pane's hooks to the one --settings file the launch names", () => {
    const command = withClaudePromptHooks('panel-1', 'claude', os.tmpdir(), 'bash');

    const folder = path.join(appDirectory, 'claude-prompts');
    const [name] = readdirSync(folder);
    const file = path.join(folder, name);
    expect(command).toContain(path.basename(file));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveProperty('hooks.PermissionRequest');
  });

  it('launches without the hooks when their settings file cannot be written', () => {
    // A file where the settings folder belongs: creating the folder fails with EEXIST.
    writeFileSync(path.join(appDirectory, 'claude-prompts'), '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(withClaudePromptHooks('panel-1', 'claude', os.tmpdir(), 'bash')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/launches without Pane's prompt hooks.*could not be written/));
    warn.mockRestore();
  });
});

