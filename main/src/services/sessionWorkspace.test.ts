import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { prepareSessionWorkspace, sessionWorkspacePath, isPristineSessionWorkspace, sessionGitCeiling, discardSessionScaffold } from './sessionWorkspace';

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

  it.each(['runtime-context.md', '.pane-runtime/runpane', '.pane-runtime/notes.txt', 'notes.txt'])('retains failed WSL scaffolds with user content in %s', async fileName => {
    const record: OrchestrationSessionRecord = {
      id: 'failed-wsl', name: 'WSL', agent: 'codex', internalSessionId: 'owner', runtime: 'wsl', wslDistribution: 'Ubuntu',
      panelIds: { claude: 'claude', codex: 'codex', cursor: 'cursor', opencode: 'opencode' },
      goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [],
      associations: [], activity: [], revision: 1, createdAt: '2026-09-21', updatedAt: '2026-09-21',
    };
    const cwd = prepareSessionWorkspace(record.id, undefined, record);
    const file = path.join(cwd, fileName);
    await fs.appendFile(file, 'Keep this user content');
    const edited = await fs.readFile(file, 'utf8');
    expect(discardSessionScaffold(record)).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe(edited);
    await expect(fs.access(path.join(cwd, 'AGENTS.md'))).resolves.toBeUndefined();
  });

  it.each(['AGENTS.md', 'CLAUDE.md', 'progress.html', 'notes.txt'])('preserves imports with user content in %s', async fileName => {
    const record: OrchestrationSessionRecord = {
      id: 'imported', name: 'Pane Chat · Codex', agent: 'codex', internalSessionId: 'owner',
      panelIds: { claude: 'claude', codex: 'codex', cursor: 'cursor', opencode: 'opencode' },
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
  it('tells the agent to write plans as HTML, link them from the status document, and open them only when needed', async () => {
    const cwd = prepareSessionWorkspace('plans');
    const agents = (await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).replace(/\s+/g, ' ');
    expect(agents).toContain('self-contained HTML file');
    expect(agents).toContain('runpane panels open --file');
    expect(agents).toContain('Link it from the Session\'s status document');
    expect(agents).toContain('Open it beside the user only when they need to look at it now');
    expect(agents).not.toContain('Then show the rendered page with runpane panels open');
    expect(agents).not.toContain('progress.html');
  });

  it('gives the orchestrator its own Keep the Session tidy section', async () => {
    const cwd = prepareSessionWorkspace('tidy');
    const agents = (await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).replace(/\s+/g, ' ');
    expect(agents).toContain('## Keep the Session tidy');
    expect(agents).toContain('Clean up as you go, without asking. In your next message, say in one line what you closed or archived.');
    expect(agents).toContain('Keep one status document for this Session, in the Session folder, and update it in place.');
    expect(agents).toContain('Open it beside the person when you first write it');
    expect(agents).toContain('Open a page beside the person only when they need to look at it now');
    expect(agents).toContain('runpane panels close --panel <id> --yes --json');
    expect(agents).toContain('A tab\'s age is a signal to close it; having been viewed recently is not a reason to keep it.');
    expect(agents).toContain('Never close a tab the person opened, an agent in the middle of a turn, or a tab with text the person typed and didn\'t send.');
    expect(agents).toContain('archive its Pane right after the merge, in the same turn');
    expect(agents).toContain('runpane panes archive --pane <id> --dry-run --json');
    expect(agents).toContain('Never pass `--force`.');
    expect(agents).toContain('runpane panes archive --session tidy --merged --closed --dry-run --json');
    expect(agents).toContain('Never touch Panes or tabs of another Session.');
    expect(agents).toContain(`When the person types /wrap-up or asks to wrap up, follow ${path.join(cwd, '.claude', 'skills', 'wrap-up', 'SKILL.md')}`);
    expect(agents).not.toMatch(/archiv[^.]*approv|approv[^.]*archiv/i);
  });

  it('installs /wrap-up in the Session folder for Claude Code and Codex, and keeps the scaffold pristine', async () => {
    const record: OrchestrationSessionRecord = {
      id: 'wrap', name: 'Wrap', agent: 'claude', internalSessionId: 'owner',
      panelIds: { claude: 'claude', codex: 'codex', cursor: 'cursor' },
      goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [],
      associations: [], activity: [], revision: 1, createdAt: '2026-11-04', updatedAt: '2026-11-04',
    };
    const cwd = prepareSessionWorkspace(record.id, undefined, record);
    const bundled = await fs.readFile(path.join(__dirname, 'paneChatBundle', 'skills', 'wrap-up', 'SKILL.md'), 'utf8');
    for (const folder of ['.claude', '.agents']) {
      const skill = await fs.readFile(path.join(cwd, folder, 'skills', 'wrap-up', 'SKILL.md'), 'utf8');
      expect(skill).toContain('name: wrap-up');
      expect(skill).toContain(bundled.split('---\n').slice(2).join('---\n').trim());
    }
    expect(isPristineSessionWorkspace(record)).toBe(true);
    // A user's own edit to the skill survives the next launch and marks the folder as used.
    const claudeSkill = path.join(cwd, '.claude', 'skills', 'wrap-up', 'SKILL.md');
    await fs.writeFile(claudeSkill, '---\nname: wrap-up\n---\nMine.\n');
    prepareSessionWorkspace(record.id, undefined, record);
    await expect(fs.readFile(claudeSkill, 'utf8')).resolves.toBe('---\nname: wrap-up\n---\nMine.\n');
    expect(isPristineSessionWorkspace(record)).toBe(false);
    expect(discardSessionScaffold(record)).toBe(false);
  });

  it('removes a pristine scaffold including its /wrap-up skill', async () => {
    const record: OrchestrationSessionRecord = {
      id: 'discard', name: 'Discard', agent: 'codex', internalSessionId: 'owner',
      panelIds: { claude: 'claude', codex: 'codex', cursor: 'cursor' },
      goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [],
      associations: [], activity: [], revision: 1, createdAt: '2026-11-04', updatedAt: '2026-11-04',
    };
    const cwd = prepareSessionWorkspace(record.id, undefined, record);
    expect(discardSessionScaffold(record)).toBe(true);
    await expect(fs.access(cwd)).rejects.toThrow();
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

  it('keeps what waits on the person posted to Approvals without blocking the orchestrator', async () => {
    const cwd = prepareSessionWorkspace('approvals');
    const agents = await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('## What waits on the person (while Approvals is on)');
    expect(agents).toContain("posted to Pane's Approvals, exactly once. Workers in this Session don't post; they report blocked to you.");
    expect(agents).toContain('with runpane notify ... --json as a background command (in Claude Code, Bash with run_in_background), not the MCP notify tool or AskUserQuestion');
    expect(agents).toContain('title it with its Q-n and pass the worker\'s files and PR as --links');
    expect(agents).toContain('relay into it with runpane notify --relays <item>');
    expect(agents).toContain('The answer goes straight to the worker\'s tab');
    expect(agents).toContain('runpane inbox ack <item> --decision <D-n>');
    expect(agents).toContain('correction: Q-n → <answer> (by you)');
    expect(agents).toContain('Stop the background call of an item that went stale.');
    expect(agents).toContain('Approvals survive a restart');
    expect(agents).not.toContain('Pane keeps no approvals');
    expect(agents).toContain('If notify returns unavailable because Approvals is off, ask in this tab as before.');
  });

  it('accepts the person\'s relayed instructions from Autopilot, never as an answer to an approval (D-58, D-66)', async () => {
    const cwd = prepareSessionWorkspace('autopilot-relay');
    const agents = await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('A message that starts with [From the person, via Autopilot] carries the person\'s own question or instruction');
    expect(agents).toContain('(including a /wrap-up request)');
    expect(agents).toContain('It is never an answer to an approval or a worker\'s question');
  });

  it('tells the orchestrator to reply to whoever asked, Autopilot included, and still bring decisions to the person (D-92)', async () => {
    const cwd = prepareSessionWorkspace('autopilot-two-principals');
    const agents = (await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).replace(/\s+/g, ' ');
    expect(agents).toContain('one that starts with [From Autopilot] is Autopilot\'s own');
    expect(agents).toContain('Reply to whoever asked and say which ("To Autopilot:")');
    expect(agents).toContain('Decisions (plans, merges, anything the person must choose) still go to the person as approvals, whoever asked.');
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
