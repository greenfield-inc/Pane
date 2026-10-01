import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { PaneCommandRegistry } from '../commandRegistry';
import { applySessionAgentDefaults, normalizeAgentDefaults, readAgentDefaults, registerAgentDefaultsHandler } from './sessionAgentDefaults';

const OPUS = 'claude-opus-5-5';

describe('runpane:cloud:agent-defaults', () => {
  let root: string;
  let serveRecordPath: string;
  let registry: PaneCommandRegistry;
  const settingsFile = () => path.join(root, '.claude', 'settings.json');
  const settings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  const writeSettings = (value: JsonObject) => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(value), { mode: 0o600 });
  };
  const deliver = (defaults: JsonObject) => registry.invoke('runpane:cloud:agent-defaults', [{ defaults }]);
  const apply = () => applySessionAgentDefaults({ home: root, serveRecordPath });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-defaults-'));
    serveRecordPath = path.join(root, 'serve.json');
    fs.writeFileSync(serveRecordPath, '{}');
    registry = new PaneCommandRegistry();
    registerAgentDefaultsHandler(registry, { home: root, serveRecordPath, now: () => new Date('2026-10-01T19:00:00Z') });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('sets Claude Code\'s model and keeps every other key in settings.json', async () => {
    writeSettings({ skipDangerousModePermissionPrompt: true, env: { FOO: '1' } });

    const result = await deliver({ claudeModel: ` ${OPUS} ` });

    expect(result).toEqual({
      ok: true,
      defaults: { claudeModel: OPUS },
      claudeModel: { configured: OPUS, inSettings: OPUS, outcome: 'set' },
      changedFiles: [settingsFile()],
    });
    expect(settings()).toEqual({ skipDangerousModePermissionPrompt: true, env: { FOO: '1' }, model: OPUS });
    expect(fs.statSync(settingsFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(root, '.runpane-cloud', 'agent-defaults.json')).mode & 0o777).toBe(0o600);
    expect(readAgentDefaults(root)).toEqual({ claudeModel: OPUS });
  });

  it('creates settings.json when Claude Code has none yet', async () => {
    await deliver({ claudeModel: OPUS });
    expect(settings()).toEqual({ model: OPUS });
  });

  it('applies again at every daemon start, idempotently, after the model was removed', async () => {
    writeSettings({ skipDangerousModePermissionPrompt: true });
    await deliver({ claudeModel: OPUS });
    writeSettings({ skipDangerousModePermissionPrompt: true });

    expect(apply()).toEqual({ claudeModel: { configured: OPUS, inSettings: OPUS, outcome: 'set' }, changedFiles: [settingsFile()] });
    const text = fs.readFileSync(settingsFile(), 'utf8');
    expect(apply()).toEqual({ claudeModel: { configured: OPUS, inSettings: OPUS, outcome: 'current' }, changedFiles: [] });
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(text);
  });

  it('keeps a model someone chose in the Session (/model) instead of overwriting it', async () => {
    await deliver({ claudeModel: OPUS });
    writeSettings({ model: 'claude-sonnet-5-5' });

    expect(apply()).toEqual({ claudeModel: { configured: OPUS, inSettings: 'claude-sonnet-5-5', outcome: 'kept-session-choice' }, changedFiles: [] });
    expect(settings()).toEqual({ model: 'claude-sonnet-5-5' });
    // A changed default does not override it either.
    expect(await deliver({ claudeModel: 'claude-opus-5-5[1m]' })).toMatchObject({ claudeModel: { outcome: 'kept-session-choice' }, changedFiles: [] });
  });

  it('keeps a model that was there before any default was delivered', async () => {
    writeSettings({ model: 'haiku' });
    expect(await deliver({ claudeModel: OPUS })).toMatchObject({ claudeModel: { inSettings: 'haiku', outcome: 'kept-session-choice' } });
    expect(settings()).toEqual({ model: 'haiku' });
  });

  it('adopts a model already set to the default (a hand-set stopgap) without rewriting the file', async () => {
    writeSettings({ skipDangerousModePermissionPrompt: true, model: OPUS });
    const text = fs.readFileSync(settingsFile(), 'utf8');

    expect(await deliver({ claudeModel: OPUS })).toMatchObject({ claudeModel: { inSettings: OPUS, outcome: 'current' }, changedFiles: [] });
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(text);
    // It is now the daemon's value, so a later default replaces it.
    expect(await deliver({ claudeModel: 'opus' })).toMatchObject({ claudeModel: { outcome: 'set' } });
    expect(settings()).toEqual({ skipDangerousModePermissionPrompt: true, model: 'opus' });
  });

  it('a new default replaces the one it wrote', async () => {
    await deliver({ claudeModel: 'opus' });
    expect(await deliver({ claudeModel: OPUS })).toMatchObject({ claudeModel: { outcome: 'set' } });
    expect(settings()).toEqual({ model: OPUS });
  });

  it('clearing the default removes only the model it wrote', async () => {
    writeSettings({ theme: 'dark' });
    await deliver({ claudeModel: OPUS });

    expect(await deliver({})).toEqual({
      ok: true,
      defaults: {},
      claudeModel: { configured: null, inSettings: null, outcome: 'removed' },
      changedFiles: [settingsFile()],
    });
    expect(settings()).toEqual({ theme: 'dark' });
    expect(apply()).toMatchObject({ claudeModel: { outcome: 'unset' }, changedFiles: [] });

    // Product default: nothing delivered means Claude Code's own default, and a user's model stays.
    writeSettings({ model: 'sonnet' });
    expect(await deliver({})).toMatchObject({ claudeModel: { inSettings: 'sonnet', outcome: 'unset' }, changedFiles: [] });
    expect(settings()).toEqual({ model: 'sonnet' });
  });

  it('never rewrites a settings.json it cannot parse', async () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), '{ "model": "x", // a comment\n}');
    expect(await deliver({ claudeModel: OPUS })).toMatchObject({ claudeModel: { outcome: 'settings-unreadable' }, changedFiles: [] });
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('{ "model": "x", // a comment\n}');
  });

  it('answers the stored defaults without changing them', async () => {
    await deliver({ claudeModel: OPUS });
    expect(await registry.invoke('runpane:cloud:agent-defaults', [])).toMatchObject({ defaults: { claudeModel: OPUS }, changedFiles: [] });
  });

  it('refuses off a Session and for bad input, and does nothing off a Session at start', async () => {
    await expect(deliver({ claudeModel: 'opus; rm -rf /' })).rejects.toMatchObject({ code: 'ERR_AGENT_DEFAULTS_INVALID' });
    await expect(deliver({ claudeModel: 7 })).rejects.toMatchObject({ code: 'ERR_AGENT_DEFAULTS_INVALID' });
    fs.rmSync(serveRecordPath);
    await expect(deliver({ claudeModel: OPUS })).rejects.toMatchObject({ code: 'ERR_AGENT_DEFAULTS_UNAVAILABLE' });
    expect(apply().changedFiles).toEqual([]);
    expect(fs.existsSync(settingsFile())).toBe(false);
  });
});

describe('normalizeAgentDefaults', () => {
  it('accepts model ids and aliases Claude Code takes', () => {
    for (const model of [OPUS, 'opus', 'sonnet', 'claude-opus-5-5[1m]', 'us.anthropic.claude-opus-5-5-v1:0']) {
      expect(normalizeAgentDefaults({ claudeModel: model })).toEqual({ claudeModel: model });
    }
    expect(normalizeAgentDefaults({})).toEqual({});
  });

  it('refuses empty, spaced or overlong values', () => {
    for (const model of ['', ' ', 'claude opus', 'x'.repeat(101), '-opus']) {
      expect(() => normalizeAgentDefaults({ claudeModel: model })).toThrow(/Not a Claude model id/u);
    }
  });
});
