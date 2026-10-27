import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readClaudeCode } from './claudeCode';
import type { ReaderContext } from './types';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reader-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function context(overrides: Partial<ReaderContext> = {}): ReaderContext {
  return {
    env: {},
    home: path.join(root, 'home'),
    platform: 'darwin',
    now: NOW,
    sinceMs: NOW - 30 * DAY,
    tempDir: root,
    isPidAlive: () => false,
    processCommands: async () => [],
    ...overrides,
  };
}

/** Fields of a transcript line, as the research note lists them. */
interface TranscriptLine {
  type?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  version?: string;
  isSidechain?: boolean;
  timestamp?: string;
  aiTitle?: string;
  customTitle?: string;
  kind?: string;
  text?: string;
}

interface RegistryEntry {
  sessionId?: string;
  cwd?: string;
}

function writeTranscript(configDir: string, project: string, id: string, lines: TranscriptLine[], mtime: number): string {
  const file = path.join(configDir, 'projects', project, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

function message(id: string, fields: TranscriptLine): TranscriptLine {
  return { type: 'user', sessionId: id, cwd: '/work/app', gitBranch: 'main', entrypoint: 'cli', version: '2.1.311', isSidechain: false, timestamp: '2026-10-25T10:00:00.000Z', ...fields };
}

function writeRegistry(configDir: string, pid: number, fields: RegistryEntry): void {
  const dir = path.join(configDir, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, kind: 'interactive', ...fields }));
}

describe('readClaudeCode', () => {
  it('reads id, folder, branch, title, last activity and running state', async () => {
    const config = path.join(root, 'home', '.claude');
    const activeA = NOW - 2 * 60 * 60 * 1000;
    const activeB = NOW - DAY;
    writeTranscript(config, '-work-app', ID_A, [
      message(ID_A, {}),
      { type: 'ai-title', aiTitle: 'Generated title', sessionId: ID_A },
      { type: 'custom-title', customTitle: 'Fix login', sessionId: ID_A },
      message(ID_A, { type: 'assistant', gitBranch: 'feature/login' }),
    ], activeA);
    writeTranscript(config, '-work-api', ID_B, [
      message(ID_B, { cwd: '/work/api', gitBranch: 'dev' }),
      { type: 'ai-title', aiTitle: 'Add rate limits', sessionId: ID_B },
    ], activeB);
    writeRegistry(config, 4242, { sessionId: ID_A, cwd: '/work/app' });
    writeRegistry(config, 5151, { sessionId: ID_B, cwd: '/work/api' });

    const result = await readClaudeCode(context({ isPidAlive: pid => pid === 4242 }));

    expect(result.status).toBe('ok');
    expect(result.sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { source: 'claude', agent: 'claude', sessionId: ID_A, folder: '/work/app', branch: 'feature/login', title: 'Fix login', lastActiveMs: activeA, running: 'yes' },
      { source: 'claude', agent: 'claude', sessionId: ID_B, folder: '/work/api', branch: 'dev', title: 'Add rate limits', lastActiveMs: activeB, running: 'no' },
    ]);
    expect(result.storePaths).toEqual([path.join(config, 'projects'), path.join(config, 'sessions')]);
  });

  it('says running is unknown when there is no live-session registry', async () => {
    const config = path.join(root, 'home', '.claude');
    writeTranscript(config, '-work-app', ID_A, [message(ID_A, {})], NOW - DAY);

    const result = await readClaudeCode(context());

    expect(result.sessions.map(session => session.running)).toEqual(['unknown']);
  });

  it.each(['darwin', 'win32', 'linux'] as const)('finds the store in <home>/.claude on %s', async platform => {
    writeTranscript(path.join(root, 'home', '.claude'), '-work-app', ID_A, [message(ID_A, {})], NOW - DAY);

    const result = await readClaudeCode(context({ platform }));

    expect(result.sessions.map(session => session.sessionId)).toEqual([ID_A]);
    expect(result.storePaths[0]).toBe(path.join(root, 'home', '.claude', 'projects'));
  });

  it('uses CLAUDE_CONFIG_DIR over the home folder', async () => {
    const custom = path.join(root, 'custom-claude');
    writeTranscript(custom, '-work-app', ID_B, [message(ID_B, {})], NOW - DAY);
    writeTranscript(path.join(root, 'home', '.claude'), '-work-app', ID_A, [message(ID_A, {})], NOW - DAY);

    const result = await readClaudeCode(context({ env: { CLAUDE_CONFIG_DIR: custom } }));

    expect(result.sessions.map(session => session.sessionId)).toEqual([ID_B]);
  });

  it('reports absent when there is no Claude Code store', async () => {
    const result = await readClaudeCode(context());

    expect(result).toMatchObject({ source: 'claude', status: 'absent', sessions: [] });
  });

  it('fails closed on a Claude Code major version it does not know', async () => {
    writeTranscript(path.join(root, 'home', '.claude'), '-work-app', ID_A, [message(ID_A, { version: '3.0.0' })], NOW - DAY);

    const result = await readClaudeCode(context());

    expect(result).toMatchObject({ status: 'unreadable', version: '3.0.0', sessions: [] });
  });

  it('fails closed when no transcript has a recognisable line', async () => {
    writeTranscript(path.join(root, 'home', '.claude'), '-work-app', ID_A, [{ kind: 'entry', text: 'hello' }], NOW - DAY);

    const result = await readClaudeCode(context());

    expect(result.status).toBe('unreadable');
  });

  it('leaves out old, non-interactive and subagent transcripts and sidecar files', async () => {
    const config = path.join(root, 'home', '.claude');
    writeTranscript(config, '-work-app', ID_A, [message(ID_A, {})], NOW - DAY);
    writeTranscript(config, '-work-app', ID_B, [message(ID_B, {})], NOW - 31 * DAY);
    writeTranscript(config, '-work-sdk', ID_C, [message(ID_C, { entrypoint: 'sdk-cli' })], NOW - DAY);
    writeTranscript(config, '-work-side', '44444444-4444-4444-8444-444444444444', [message('44444444-4444-4444-8444-444444444444', { isSidechain: true })], NOW - DAY);
    writeTranscript(config, '-work-app', `${ID_A}.orphaned-1761400000-ab12`, [message(ID_A, {})], NOW - DAY);

    const result = await readClaudeCode(context());

    expect(result.sessions.map(session => session.sessionId)).toEqual([ID_A]);
  });

  it('leaves the store untouched', async () => {
    const config = path.join(root, 'home', '.claude');
    const file = writeTranscript(config, '-work-app', ID_A, [message(ID_A, {})], NOW - DAY);
    writeRegistry(config, 4242, { sessionId: ID_A });
    const registry = path.join(config, 'sessions', '4242.json');
    const before = [fs.readFileSync(file), fs.statSync(file).mtimeMs, fs.readFileSync(registry), fs.statSync(registry).mtimeMs];

    await readClaudeCode(context({ isPidAlive: () => true }));

    expect([fs.readFileSync(file), fs.statSync(file).mtimeMs, fs.readFileSync(registry), fs.statSync(registry).mtimeMs]).toEqual(before);
  });

  it('reports the folder of a live session even when its transcript is too old to list', async () => {
    const config = path.join(root, 'home', '.claude');
    writeTranscript(config, '-work-app', ID_A, [message(ID_A, {})], NOW - 60 * DAY);
    writeTranscript(config, '-work-app', ID_B, [message(ID_B, {})], NOW - DAY);
    writeTranscript(config, '-work-api', ID_C, [message(ID_C, { cwd: '/work/api' })], NOW - 90 * DAY);
    writeRegistry(config, 4242, { sessionId: ID_A, cwd: '/work/app' });
    writeRegistry(config, 5151, { sessionId: ID_C });

    const result = await readClaudeCode(context({ isPidAlive: pid => pid === 4242 || pid === 5151 }));

    expect(result.sessions.map(session => [session.sessionId, session.running])).toEqual([[ID_B, 'no']]);
    expect(result.busy).toEqual([
      { folder: '/work/app', agent: 'claude', sessionId: ID_A },
      { folder: '/work/api', agent: 'claude', sessionId: ID_C },
    ]);
  });
});
