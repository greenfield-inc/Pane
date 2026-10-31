import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { withSessionFolderAccess } from '../agents/sessionFolderAccess';
import { mergeClaudeSettingsFlag } from './claudeLaunchSettings';

const paneHooks = { hooks: { PermissionRequest: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:4000/claude' }] }] } };

/** The words a POSIX shell passes to the program. */
function words(command: string): string[] {
  return execFileSync('/bin/sh', ['-c', `words() { for word; do printf '%s\\0' "$word"; done; }; words ${command}`], { encoding: 'utf8' }).split('\0').slice(0, -1);
}

describe.skipIf(process.platform === 'win32')('mergeClaudeSettingsFlag', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'pane-claude-settings-'));
  const file = path.join(cwd, "pane's settings.json");

  it('replaces the Session-folder --settings with one file that holds both', () => {
    const folder = '/Users/me/.pane/sessions/s-1';
    const { command } = withSessionFolderAccess({ title: 'Claude Code', command: 'claude --dangerously-skip-permissions', agent: 'claude' }, folder, 'darwin');
    const merged = mergeClaudeSettingsFlag({ command: `${command} --session-id abc 'Read brief.md'`, cwd, shellType: 'zsh', file, extra: paneHooks });

    expect(words(merged!.command)).toEqual(['claude', '--settings', file, '--dangerously-skip-permissions', '--session-id', 'abc', 'Read brief.md']);
    expect(merged!.settings).toEqual({
      permissions: { additionalDirectories: [folder], deny: [`Edit(/${folder}/**)`] },
      ...paneHooks,
    });
  });

  it("merges a user's settings file and joins hook lists for the same event", () => {
    writeFileSync(path.join(cwd, 'mine.json'), JSON.stringify({ model: 'opus', hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'say hi' }] }] } }));
    const merged = mergeClaudeSettingsFlag({ command: 'claude --settings=mine.json', cwd, shellType: 'bash', file, extra: paneHooks });

    expect(words(merged!.command)).toEqual(['claude', '--settings', file]);
    expect(merged!.settings).toEqual({
      model: 'opus',
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'say hi' }] }, ...paneHooks.hooks.PermissionRequest] },
    });
  });

  it("reads Pane's own earlier file as nothing, so a relaunch doesn't repeat its hooks", () => {
    const merged = mergeClaudeSettingsFlag({ command: `claude --settings '${file.replace(/'/g, `'\\''`)}' --resume abc`, cwd, shellType: 'bash', file, extra: paneHooks });

    expect(words(merged!.command)).toEqual(['claude', '--settings', file, '--resume', 'abc']);
    expect(merged!.settings).toEqual(paneHooks);
  });

  it('leaves wrappers alone, and gives up on settings it cannot read or a command it cannot parse', () => {
    expect(mergeClaudeSettingsFlag({ command: 'claude --settings missing.json', cwd, shellType: 'bash', file, extra: paneHooks })).toBeUndefined();
    expect(mergeClaudeSettingsFlag({ command: "claude --settings '{not json'", cwd, shellType: 'bash', file, extra: paneHooks })).toBeUndefined();
    expect(mergeClaudeSettingsFlag({ command: 'claude "unterminated', cwd, shellType: 'bash', file, extra: paneHooks })).toBeUndefined();
    expect(mergeClaudeSettingsFlag({ command: 'agent-farm run claude --model opus', cwd, shellType: 'bash', file, extra: paneHooks })).toBeUndefined();
  });
});
