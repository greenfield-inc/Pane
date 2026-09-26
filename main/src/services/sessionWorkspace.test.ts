import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { prepareSessionWorkspace, sessionWorkspacePath, isPristineSessionWorkspace, sessionGitCeiling } from './sessionWorkspace';

describe('Session workspace instructions', () => {
  const previousPaneDir = process.env.PANE_DIR;
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-session-workspace-'));
    process.env.PANE_DIR = root;
  });

  afterEach(async () => {
    if (previousPaneDir === undefined) delete process.env.PANE_DIR;
    else process.env.PANE_DIR = previousPaneDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('allocates distinct stable folders and keeps opaque IDs inside the managed root', async () => {
    const first = prepareSessionWorkspace('session-a');
    const second = prepareSessionWorkspace('session-b');
    const unusual = prepareSessionWorkspace('../session/a');
    expect(first).not.toBe(second);
    expect(path.dirname(unusual)).toBe(path.join(root, 'sessions'));
    expect(unusual).not.toBe(prepareSessionWorkspace('..%2Fsession%2Fa'));
    await fs.writeFile(path.join(first, 'notes.md'), 'Keep this artifact.');
    expect(prepareSessionWorkspace('session-a', 'Updated behavior.')).toBe(first);
    expect(sessionWorkspacePath('session-a')).toBe(first);
    await expect(fs.readFile(path.join(first, 'notes.md'), 'utf8')).resolves.toBe('Keep this artifact.');
  });

  it.each(['AGENTS.md', 'CLAUDE.md', 'progress.html', 'notes.txt'])('preserves imports with user content in %s', async fileName => {
    const record: OrchestrationSessionRecord = {
      id: 'imported', name: 'Pane Chat · Codex', agent: 'codex', internalSessionId: 'owner',
      panelIds: { claude: 'claude', codex: 'codex', cursor: 'cursor' },
      goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [],
      associations: [], activity: [], revision: 1, createdAt: '2026-09-21', updatedAt: '2026-09-21',
    };
    expect(isPristineSessionWorkspace(record)).toBe(true);
    const cwd = prepareSessionWorkspace(record.id, undefined, record, true);
    expect(isPristineSessionWorkspace(record)).toBe(true);
    prepareSessionWorkspace(record.id, undefined, record, false);
    expect(isPristineSessionWorkspace(record)).toBe(true);
    const file = path.join(cwd, fileName);
    await fs.appendFile(file, 'Keep my user content');
    const edited = await fs.readFile(file, 'utf8');
    expect(isPristineSessionWorkspace(record)).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe(edited);
  });

  it('prepares Sessions under a repository such as a dotfiles home, and stops git discovery above them', async () => {
    const home = path.join(root, 'home');
    await fs.mkdir(path.join(home, '.git'), { recursive: true });
    process.env.PANE_DIR = path.join(home, '.pane');
    const cwd = prepareSessionWorkspace('dotfiles');
    expect(await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toContain('dotfiles');
    expect(sessionGitCeiling()).toBe(path.dirname(cwd));
  });

  it('keeps the generated section intact when a profile contains its end marker', async () => {
    const cwd = prepareSessionWorkspace('markers', 'Before <!-- pane-session-context:end --> after');
    expect(() => prepareSessionWorkspace('markers', 'Revised profile')).not.toThrow();
    const content = await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8');
    expect(content).toContain('Revised profile');
    expect(content).not.toContain('Before');
  });

  it('replaces generated instructions while preserving user text and Claude imports', async () => {
    const cwd = prepareSessionWorkspace('session-a', 'Original profile.');
    const agentsPath = path.join(cwd, 'AGENTS.md');
    const original = await fs.readFile(agentsPath, 'utf8');
    await fs.writeFile(agentsPath, `User preface.\n${original}\nUser footer.\n`);
    const claudePath = path.join(cwd, 'CLAUDE.md');
    await fs.appendFile(claudePath, '\nUser Claude instructions.\n');
    prepareSessionWorkspace('session-a', 'Revised profile.');
    prepareSessionWorkspace('session-a', 'Revised profile.');
    const agents = await fs.readFile(agentsPath, 'utf8');
    expect(agents).toContain('User preface.');
    expect(agents).toContain('User footer.');
    expect(agents).toContain('Revised profile.');
    expect(agents).not.toContain('Original profile.');
    expect(agents.match(/pane-session-context:start/g)).toHaveLength(1);
    expect(agents).toContain('Opening it does not authorize work. Await user input.');
    expect(agents).toContain('PANE_ORCHESTRATION_SESSION_ID');
    const claude = await fs.readFile(claudePath, 'utf8');
    expect(claude).toContain('@AGENTS.md');
    expect(claude).toContain('User Claude instructions.');
    expect(claude.match(/pane-session-context:start/g)).toHaveLength(1);
  });

  it('refuses to overwrite instructions with incomplete managed markers', async () => {
    const cwd = prepareSessionWorkspace('session-a');
    const agentsPath = path.join(cwd, 'AGENTS.md');
    const broken = 'User content.\n<!-- pane-session-context:start -->\nIncomplete';
    await fs.writeFile(agentsPath, broken);
    expect(() => prepareSessionWorkspace('session-a')).toThrow('markers are incomplete');
    await expect(fs.readFile(agentsPath, 'utf8')).resolves.toBe(broken);
  });
  it('requires Pane delegation instead of silent fallbacks', async () => {
    const cwd = prepareSessionWorkspace('delegation');
    const agents = await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8');
    expect(agents).toContain(`runpane doctor --json --pane-dir "${root}"`);
    expect(agents).toContain('$PANE_RUNPANE_BIN');
    expect(agents).toContain('associated with this Session automatically');
    expect(agents).toContain('runpane sessions overview --session delegation --json');
    expect(agents).toContain('Never substitute plain git worktrees');
    expect(agents).toContain(path.join(root, 'skills', 'pane-chat', 'pane-orchestrator', 'SKILL.md'));
  });

  it('removes the legacy progress switch but keeps user documents', async () => {
    const cwd = sessionWorkspacePath('legacy-progress');
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, '.pane-progress.json'), '{"enabled":true}');
    await fs.writeFile(path.join(cwd, 'progress.html'), '<h1>Working</h1>');
    prepareSessionWorkspace('legacy-progress');
    await expect(fs.access(path.join(cwd, '.pane-progress.json'))).rejects.toThrow();
    await expect(fs.readFile(path.join(cwd, 'progress.html'), 'utf8')).resolves.toBe('<h1>Working</h1>');
  });

});
