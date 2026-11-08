import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTIFY_SETTINGS } from '../../../../shared/types/notify';
import { NotifyQueue } from '../notify/notifyQueue';
import { ClaudePromptBridge } from './claudePromptBridge';
import { CONVERSATION_HOOK, setClaudePromptBridge, withClaudePromptHooks } from '.';

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

  it('adds the conversation hook with Notify off, and only once when the command already names the file (D-269)', () => {
    setClaudePromptBridge(undefined);
    const command = withClaudePromptHooks('panel-1', 'claude', os.tmpdir(), 'bash');
    const folder = path.join(appDirectory, 'claude-prompts');
    const file = path.join(folder, readdirSync(folder)[0]);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written).not.toHaveProperty('hooks.PermissionRequest');
    expect(written.hooks.SessionStart).toEqual(JSON.parse(JSON.stringify(CONVERSATION_HOOK)).hooks.SessionStart);
    expect(written.hooks.SessionStart[0].hooks[0].command).toContain('panels conversation --hook');

    // A restart resolves the same command again: the file keeps one hook, not two.
    withClaudePromptHooks('panel-1', command ?? '', os.tmpdir(), 'bash');
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.SessionStart).toHaveLength(1);
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

