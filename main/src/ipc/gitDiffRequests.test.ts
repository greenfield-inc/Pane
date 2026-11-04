import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { GitDiffManager } from '../services/gitDiffManager';
import { CommandRunner } from '../utils/commandRunner';
import type { AppServices } from './types';
import { diffScopeSchema, fileDiffRequestSchema, isHexHash, registerGitDiffRequestHandlers } from './gitDiffRequests';

const directories: string[] = [];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pane-git-diff-ipc-'));
  directories.push(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Pane Test');
  git(cwd, 'config', 'user.email', 'pane@example.test');
  writeFileSync(join(cwd, 'base.txt'), 'base\n');
  git(cwd, 'add', '--', 'base.txt');
  git(cwd, 'commit', '-m', 'base');
  git(cwd, 'checkout', '-b', 'feature');
  writeFileSync(join(cwd, 'feature.txt'), 'feature\n');
  git(cwd, 'add', '--', 'feature.txt');
  git(cwd, 'commit', '-m', 'feature');
  return cwd;
}

function registeredHarness(cwd: string) {
  const commandRunner = new CommandRunner({ path: cwd });
  const session = {
    id: 'active-session',
    worktreePath: cwd,
    archived: false,
    baseBranch: 'renderer-must-not-use-this',
  };
  const archivedSession = { ...session, id: 'archived-session', archived: true };
  const context = {
    project: { id: 1, name: 'test', path: cwd },
    pathResolver: {},
    commandRunner,
  };
  const getSession = vi.fn((sessionId: string) => {
    if (sessionId === session.id) return session;
    if (sessionId === archivedSession.id) return archivedSession;
    return undefined;
  });
  const getProjectContext = vi.fn((sessionId: string) => sessionId === session.id ? context : null);
  const getSessionComparisonBranch = vi.fn(async () => 'main');
  // SAFETY: The handler test supplies the minimal service graph exercised by these two registry commands.
  const services = {
    sessionManager: { getSession, getProjectContext },
    worktreeManager: { getSessionComparisonBranch },
    gitDiffManager: new GitDiffManager(),
  } as AppServices;
  const registry = new PaneCommandRegistry();
  registerGitDiffRequestHandlers(registry, services);
  return { registry, session, context, getSessionComparisonBranch };
}

afterEach(() => {
  vi.mocked(console.warn).mockClear();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('git diff request boundary', () => {
  it('decodes all five scope variants', () => {
    const scopes = [
      { kind: 'session' },
      { kind: 'commit', hash: 'abcd' },
      { kind: 'working-tree' },
      { kind: 'commit-range', olderHash: 'abcd', newerHash: '1234' },
      { kind: 'working-tree-range', baseHash: 'abcd' },
    ];
    expect(scopes.map(scope => decodeBoundary(scope, diffScopeSchema))).toEqual(scopes);
  });

  it('validates hashes and file requests', () => {
    expect(isHexHash('abcdef012345')).toBe(true);
    expect(isHexHash('a'.repeat(64))).toBe(true);
    expect(isHexHash('a'.repeat(65))).toBe(false);
    expect(isHexHash('not-a-hash')).toBe(false);
    expect(decodeBoundary({ path: '[literal]*.ts', previousPath: 'old.ts' }, fileDiffRequestSchema)).toEqual({ path: '[literal]*.ts', previousPath: 'old.ts' });
  });

  it('preserves JSON prototype keys as own data with ordinary object prototypes', () => {
    const input = JSON.parse('{"path":"file.ts","__proto__":{"previousPath":"foreign.ts"},"nested":{"__proto__":{"kind":"commit"}}}');
    const decoded = decodeBoundary(input, boundary.jsonObject);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
    expect(decoded).toEqual(input);
    const nested = decodeBoundary(decoded.nested, boundary.jsonObject);
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
    expect(decodeBoundary(decoded, fileDiffRequestSchema)).toEqual({ path: 'file.ts' });
    expect(decodeBoundary({ path: 'file.ts', omitted: undefined }, boundary.jsonObject)).toEqual({ path: 'file.ts' });
  });

  it('ignores inherited optional request fields and rejects inherited required scope fields', () => {
    const request = { path: 'file.ts' };
    Object.setPrototypeOf(request, { previousPath: 'foreign.ts' });
    expect(decodeBoundary(request, fileDiffRequestSchema)).toEqual({ path: 'file.ts' });
    const scope = { hash: 'abcd' };
    Object.setPrototypeOf(scope, { kind: 'commit' });
    expect(() => decodeBoundary(scope, diffScopeSchema)).toThrow('did not match any allowed shape');
  });
});

describe('git diff registry handlers', () => {
  it('returns manifest and file data using only the server-resolved session comparison base', async () => {
    const cwd = repository();
    const { registry, session, context, getSessionComparisonBranch } = registeredHarness(cwd);
    const rendererScope = { kind: 'session', base: 'renderer/override', comparisonBase: 'renderer/override' };

    const manifestResponse = await registry.invoke('sessions:get-diff-manifest', [session.id, rendererScope]);
    expect(manifestResponse).toMatchObject({
      success: true,
      data: {
        scope: { kind: 'session' },
        files: [{ path: 'feature.txt', kind: 'added' }],
        resolvedBase: { kind: 'comparison-base', ref: 'main' },
      },
    });

    const fileResponse = await registry.invoke('sessions:get-file-diff', [session.id, rendererScope, { path: 'feature.txt' }]);
    expect(fileResponse).toMatchObject({
      success: true,
      data: { status: 'changed', file: { path: 'feature.txt', kind: 'added' } },
    });
    expect(getSessionComparisonBranch).toHaveBeenCalledTimes(2);
    expect(getSessionComparisonBranch).toHaveBeenNthCalledWith(1, session, context);
    expect(getSessionComparisonBranch).toHaveBeenNthCalledWith(2, session, context);
  });

  it('serves SHA-256 commit, root, and commit-range scopes when supported', async (context) => {
    const cwd = mkdtempSync(join(tmpdir(), 'pane-git-diff-ipc-sha256-'));
    directories.push(cwd);
    try {
      git(cwd, 'init', '--object-format=sha256', '-b', 'main');
    } catch {
      context.skip();
      return;
    }
    git(cwd, 'config', 'user.name', 'Pane Test');
    git(cwd, 'config', 'user.email', 'pane@example.test');
    writeFileSync(join(cwd, 'root.txt'), 'root\n');
    git(cwd, 'add', '--', 'root.txt');
    git(cwd, 'commit', '-m', 'root');
    const root = git(cwd, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(cwd, 'child.txt'), 'child\n');
    git(cwd, 'add', '--', 'child.txt');
    git(cwd, 'commit', '-m', 'child');
    const child = git(cwd, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(cwd, 'newest.txt'), 'newest\n');
    git(cwd, 'add', '--', 'newest.txt');
    git(cwd, 'commit', '-m', 'newest');
    const newest = git(cwd, 'rev-parse', 'HEAD').trim();
    const emptyTree = git(cwd, 'hash-object', '-t', 'tree', '/dev/null').trim();
    const { registry, session } = registeredHarness(cwd);

    const commitResponse = await registry.invoke('sessions:get-diff-manifest', [
      session.id,
      { kind: 'commit', hash: child },
    ]);
    const rootResponse = await registry.invoke('sessions:get-diff-manifest', [
      session.id,
      { kind: 'commit', hash: root },
    ]);
    const rangeResponse = await registry.invoke('sessions:get-diff-manifest', [
      session.id,
      { kind: 'commit-range', olderHash: child, newerHash: newest },
    ]);

    expect(root).toHaveLength(64);
    expect(commitResponse).toMatchObject({ success: true, data: { files: [{ path: 'child.txt' }] } });
    expect(rootResponse).toMatchObject({
      success: true,
      data: { files: [{ path: 'root.txt' }], resolvedBase: { kind: 'empty-tree', hash: emptyTree } },
    });
    expect(rangeResponse).toMatchObject({
      success: true,
      data: { files: [{ path: 'child.txt' }, { path: 'newest.txt' }], resolvedBase: { hash: root } },
    });
  });

  it.each([
    ['malformed scope', 'sessions:get-diff-manifest', ['active-session', { kind: 'not-a-scope' }], 'invalid-scope'],
    ['non-hex commit', 'sessions:get-diff-manifest', ['active-session', { kind: 'commit', hash: 'not-a-hash' }], 'unknown-commit'],
    ['unreachable hex commit', 'sessions:get-diff-manifest', ['active-session', { kind: 'commit', hash: 'deadbeef' }], 'unknown-commit'],
    ['empty path', 'sessions:get-file-diff', ['active-session', { kind: 'working-tree' }, { path: '' }], 'invalid-path'],
    ['absolute path', 'sessions:get-file-diff', ['active-session', { kind: 'working-tree' }, { path: '/tmp/outside' }], 'invalid-path'],
    ['parent-relative path', 'sessions:get-file-diff', ['active-session', { kind: 'working-tree' }, { path: '../outside' }], 'invalid-path'],
    ['archived session', 'sessions:get-diff-manifest', ['archived-session', { kind: 'session' }], 'archived'],
    ['missing session', 'sessions:get-file-diff', ['missing-session', { kind: 'working-tree' }, { path: 'feature.txt' }], 'session-not-found'],
  ] as const)('returns %s as %s', async (_label, channel, args, code) => {
    const cwd = repository();
    const { registry } = registeredHarness(cwd);

    const response = await registry.invoke(channel, args);

    expect(response).toMatchObject({ success: false, code });
  });

  it('logs one redacted diagnostic for each handler failure', async () => {
    const cwd = repository();
    const { registry } = registeredHarness(cwd);
    const warn = vi.mocked(console.warn);

    await registry.invoke('sessions:get-diff-manifest', ['active-session', { kind: 'bad-scope' }]);
    await registry.invoke('sessions:get-file-diff', [
      'active-session',
      { kind: 'working-tree' },
      { path: '../secret.patch' },
    ]);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, '[IPC:git-diff] sessions:get-diff-manifest failed', {
      sessionId: 'active-session',
      scopeKind: 'unknown',
      code: 'invalid-scope',
    });
    expect(warn).toHaveBeenNthCalledWith(2, '[IPC:git-diff] sessions:get-file-diff failed', {
      sessionId: 'active-session',
      scopeKind: 'working-tree',
      code: 'invalid-path',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret.patch');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('diff --git');
  });
});
