import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchClaudeSettings } from './claudeSettingsWatcher';

describe('watchClaudeSettings', () => {
  const dirs: string[] = [];
  const stops: Array<() => void> = [];

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  // No settings.json is written before a watch starts: macOS reports file events late, so it could still arrive.
  async function claudeDir() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-claude-settings-'));
    dirs.push(dir);
    return dir;
  }

  async function replaceSettings(dir: string, text: string) {
    // The way editors and Claude Code save it: a new file renamed over the old one.
    const temp = path.join(dir, `settings.json.${Math.random().toString(16).slice(2)}.tmp`);
    await fs.writeFile(temp, text);
    await fs.rename(temp, path.join(dir, 'settings.json'));
  }

  it('signals once after a burst of replacements of settings.json settles', async () => {
    const dir = await claudeDir();
    const onChange = vi.fn();
    stops.push(watchClaudeSettings(onChange, { dir, debounceMs: 100 }));

    await replaceSettings(dir, '{"model":"opus"}');
    await replaceSettings(dir, '{"model":"sonnet"}');
    await fs.writeFile(path.join(dir, 'settings.json'), '{"model":"claude-opus-5-5"}');

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(onChange).toHaveBeenCalledTimes(1);
    // It only watches: the file is what the last write left.
    expect(await fs.readFile(path.join(dir, 'settings.json'), 'utf8')).toBe('{"model":"claude-opus-5-5"}');
  });

  it('ignores other files in the folder', async () => {
    const dir = await claudeDir();
    const onChange = vi.fn();
    stops.push(watchClaudeSettings(onChange, { dir, debounceMs: 50 }));

    await fs.writeFile(path.join(dir, 'history.jsonl'), 'line\n');
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('stops signalling once stopped, even for a change already waiting', async () => {
    const dir = await claudeDir();
    const onChange = vi.fn();
    const stop = watchClaudeSettings(onChange, { dir, debounceMs: 150 });

    await replaceSettings(dir, '{"model":"opus"}');
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
    await replaceSettings(dir, '{"model":"sonnet"}');
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('does nothing, without throwing, when the folder does not exist', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stop = watchClaudeSettings(vi.fn(), { dir: path.join(os.tmpdir(), 'pane-claude-settings-missing', 'nope') });

    expect(stop).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
