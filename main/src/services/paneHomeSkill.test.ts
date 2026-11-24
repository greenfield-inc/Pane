import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PANE_MANAGED_SKILL_MARKER,
  buildPaneHomeSkill,
  installPaneHomeSkill,
  paneHomeSkillDirs,
  paneWslHomeSkillDirs,
  removePaneHomeSkill,
  syncPaneHomeSkill,
} from './paneHomeSkill';

describe('Pane home skill', () => {
  let home: string;
  let dirs: string[];

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-home-skill-'));
    dirs = paneHomeSkillDirs({}, home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  const skillPath = (dir: string) => path.join(dir, 'SKILL.md');

  it('does not touch home skills when OS integration is disabled for an isolated runtime', async () => {
    await fs.mkdir(dirs[0], { recursive: true });
    const previous = `old managed skill\n${PANE_MANAGED_SKILL_MARKER}\n`;
    await fs.writeFile(skillPath(dirs[0]), previous);
    vi.stubEnv('PANE_DISABLE_OS_INTEGRATION', '1');
    expect(await syncPaneHomeSkill({}, dirs)).toEqual([]);
    expect(await syncPaneHomeSkill({ agentContext: { homeSkill: false } }, dirs)).toEqual([]);
    await expect(fs.readFile(skillPath(dirs[0]), 'utf8')).resolves.toBe(previous);
    await expect(fs.access(dirs[1])).rejects.toThrow();
  });

  it('targets Claude user skills (honoring CLAUDE_CONFIG_DIR) and ~/.agents/skills', () => {
    expect(paneHomeSkillDirs({}, home)).toEqual([
      path.join(home, '.claude', 'skills', 'pane'),
      path.join(home, '.agents', 'skills', 'pane'),
    ]);
    expect(paneHomeSkillDirs({ CLAUDE_CONFIG_DIR: '/tmp/claude-alt' }, home)[0]).toBe(path.join('/tmp/claude-alt', 'skills', 'pane'));
    expect(paneWslHomeSkillDirs('Ubuntu', '/home/anna', '/home/anna/.config/claude')).toEqual([
      '\\\\wsl.localhost\\Ubuntu\\home\\anna\\.config\\claude\\skills\\pane',
      '\\\\wsl.localhost\\Ubuntu\\home\\anna\\.agents\\skills\\pane',
    ]);
  });

  it('points every agent at the bundled orchestrator guide', () => {
    const skill = buildPaneHomeSkill();
    expect(skill).toContain('runpane docs read --doc skills/pane-orchestration/SKILL.md');
  });

  it('installs a marked skill and rewrites only when it changes', async () => {
    expect((await installPaneHomeSkill(dirs)).map(result => result.outcome)).toEqual(['written', 'written']);
    const content = await fs.readFile(skillPath(dirs[0]), 'utf8');
    expect(content).toBe(buildPaneHomeSkill());
    expect(content.startsWith('---\nname: pane\n')).toBe(true);
    expect(content).toContain(PANE_MANAGED_SKILL_MARKER);
    expect((await installPaneHomeSkill(dirs)).map(result => result.outcome)).toEqual(['unchanged', 'unchanged']);

    await fs.writeFile(skillPath(dirs[1]), `old\n${PANE_MANAGED_SKILL_MARKER}\n`);
    expect((await installPaneHomeSkill(dirs))[1].outcome).toBe('written');
    await expect(fs.readFile(skillPath(dirs[1]), 'utf8')).resolves.toBe(buildPaneHomeSkill());
  });

  it('tells an agent how to reach Pane and the person when its tools look missing', () => {
    const skill = buildPaneHomeSkill();
    const description = /^description: (.*)$/m.exec(skill)?.[1] ?? '';
    for (const trigger of ['worktree', 'Session', 'notify', 'runpane', 'machine']) expect(description).toContain(trigger);
    expect(skill).toContain('runpane notify --ui options');
    expect(skill).toContain('"$PANE_RUNPANE_BIN"');
    expect(skill.indexOf('~/.pane/bin/runpane')).toBeLessThan(skill.indexOf('npx --yes runpane@latest'));
    expect(skill).toContain('runpane docs search --query');
    expect(skill).toContain('runpane workspace <machine> exec');
  });

  it('tells a Session worker to report blocked and an orchestrator to post in the background', () => {
    const skill = buildPaneHomeSkill().replace(/\s+/g, ' ');
    expect(PANE_MANAGED_SKILL_MARKER).toBe('<!-- pane-managed-skill v4 -->');
    expect(skill).toContain("A worker in a Session** (`PANE_SESSION_DIR` is set and `PANE_ORCHESTRATION_SESSION_ID` isn't");
    expect(skill).toContain("doesn't call `notify`. Run `runpane report --state blocked --question '<question>'`");
    expect(skill).toContain('Start the question with its Q-n when your orchestrator gave you one');
    expect(skill).toContain('never double quotes or no quotes');
    expect(skill).toContain('--tool-command "<launcher command>"');
    expect(skill).toContain('A Session orchestrator** (`PANE_ORCHESTRATION_SESSION_ID` is set) keeps each item that waits on the person posted once, as a background `runpane notify');
    expect(skill).toContain('Any other agent** calls `notify` as above.');
  });

  it('says Pane decides who asks, how answers arrive and how to wait, over any profile', () => {
    const skill = buildPaneHomeSkill().replace(/\s+/g, ' ');
    expect(skill).toContain('win over a profile or brief that says otherwise');
    expect(skill).toContain('in a Session a worker never asks the person itself, and an orchestrator never uses `AskUserQuestion`');
    expect(skill).toContain('the orchestrator sends no `answer:` or `recorded:` line of its own for it');
    expect(skill).toContain('A question the plan or an earlier decision settles, it answers the worker itself.');
    expect(skill).toContain('This watch is the only watcher');
  });

  it("scopes Claude's own card to agents outside a Session in the chooser itself", () => {
    const skill = buildPaneHomeSkill().replace(/\s+/g, ' ');
    const chooser = skill.split(' - ').find(bullet => bullet.startsWith("**Claude's own card (AskUserQuestion)**"));
    expect(chooser).toMatch(/^\*\*Claude's own card \(AskUserQuestion\)\*\* only outside a Session \(you are neither a worker in one nor its orchestrator\), and only when all of these hold/);
    expect(skill).toContain('**In a Session, never AskUserQuestion**, even for a quick question the person typed in your tab');
    expect(skill).toContain('Only when `runpane notify` returns `unavailable` because Approvals is off does the orchestrator ask in its own tab, as a plain message.');
  });

  it('tells an agent a typed reply is recorded as the answer, and to reopen and update instead of re-asking', () => {
    const skill = buildPaneHomeSkill().replace(/\s+/g, ' ');
    expect(skill).toContain('`reply: Q-n → "<their words>" (picked: <picks>) (by you)`');
    expect(skill).toContain('Pane records the reply as the answer once it reaches you');
    expect(skill).toContain('run `runpane notify --took <id|Q-n> question --json` at once. That reopens the approval');
    expect(skill).toContain('`runpane notify --update <id|Q-n> --asked "<their question>" --what-changed "<one line per change>" --json`');
    expect(skill).toContain('never post a second approval for it.');
    expect(skill).toContain('`correction: Q-n → that was your answer: "…" (by you)` means it is recorded as the answer: act on it.');
    expect(skill).toContain('about 80 to 100 characters on one line');
    expect(skill).toContain('{"label":"Q-12","approval":"<id|Q-n>"}');
  });

  it('upgrades a copy an older Pane marked and leaves a newer one alone', async () => {
    await installPaneHomeSkill(dirs);
    const v1 = `---\nname: pane\n---\n<!-- pane-managed-skill v1 -->\nold text\n`;
    const v99 = `---\nname: pane\n---\n<!-- pane-managed-skill v99 -->\nfrom a newer Pane\n`;
    await fs.writeFile(skillPath(dirs[0]), v1);
    await fs.writeFile(skillPath(dirs[1]), v99);

    expect((await installPaneHomeSkill(dirs)).map(result => result.outcome)).toEqual(['written', 'newer']);
    await expect(fs.readFile(skillPath(dirs[0]), 'utf8')).resolves.toBe(buildPaneHomeSkill());
    await expect(fs.readFile(skillPath(dirs[1]), 'utf8')).resolves.toBe(v99);

    await fs.writeFile(skillPath(dirs[0]), v1);
    expect((await removePaneHomeSkill(dirs)).map(result => result.outcome)).toEqual(['removed', 'newer']);
    await expect(fs.readFile(skillPath(dirs[1]), 'utf8')).resolves.toBe(v99);
  });

  it('leaves an old copy alone once the user removed its marker', async () => {
    await fs.mkdir(dirs[0], { recursive: true });
    const edited = '---\nname: pane\n---\nmy edited copy of the old Pane skill\n';
    await fs.writeFile(skillPath(dirs[0]), edited);

    expect((await installPaneHomeSkill(dirs))[0].outcome).toBe('user-owned');
    await expect(fs.readFile(skillPath(dirs[0]), 'utf8')).resolves.toBe(edited);
  });

  it('never overwrites or removes a skill the user wrote', async () => {
    await fs.mkdir(dirs[0], { recursive: true });
    await fs.writeFile(skillPath(dirs[0]), 'my own pane skill');
    await fs.mkdir(dirs[1], { recursive: true });

    expect((await installPaneHomeSkill(dirs)).map(result => result.outcome)).toEqual(['user-owned', 'user-owned']);
    await expect(fs.readFile(skillPath(dirs[0]), 'utf8')).resolves.toBe('my own pane skill');
    await expect(fs.access(skillPath(dirs[1]))).rejects.toThrow();

    expect((await removePaneHomeSkill(dirs)).map(result => result.outcome)).toEqual(['user-owned', 'absent']);
    await expect(fs.readFile(skillPath(dirs[0]), 'utf8')).resolves.toBe('my own pane skill');
  });

  it('does not follow symlinks', async () => {
    const elsewhere = path.join(home, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.mkdir(path.dirname(dirs[0]), { recursive: true });
    await fs.symlink(elsewhere, dirs[0]);
    const target = path.join(home, 'target.md');
    await fs.writeFile(target, `${PANE_MANAGED_SKILL_MARKER}\nsomeone else's file`);
    await fs.mkdir(dirs[1], { recursive: true });
    await fs.symlink(target, skillPath(dirs[1]));

    expect((await installPaneHomeSkill(dirs)).map(result => result.outcome)).toEqual(['unsafe', 'unsafe']);
    await expect(fs.readdir(elsewhere)).resolves.toEqual([]);
    expect((await removePaneHomeSkill(dirs)).map(result => result.outcome)).toEqual(['unsafe', 'unsafe']);
    await expect(fs.readFile(target, 'utf8')).resolves.toContain("someone else's file");
  });

  it('removes only its own file and keeps a folder the user added to', async () => {
    await installPaneHomeSkill(dirs);
    await fs.writeFile(path.join(dirs[1], 'extra.md'), 'mine');

    expect((await removePaneHomeSkill(dirs)).map(result => result.outcome)).toEqual(['removed', 'removed']);
    await expect(fs.access(dirs[0])).rejects.toThrow();
    await expect(fs.readdir(dirs[1])).resolves.toEqual(['extra.md']);
    expect((await removePaneHomeSkill(dirs)).map(result => result.outcome)).toEqual(['absent', 'absent']);
  });

  it("leaves Claude's copy to the pane Claude plugin while it is on, and writes it again once it is off", async () => {
    const claudeDir = path.join(home, '.claude');
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);
    const plugin = (on: boolean) => fs.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'pane@claude-plugins-official': on } }));
    expect((await syncPaneHomeSkill({}, dirs)).map(result => result.outcome)).toEqual(['written', 'written']);

    await plugin(true);
    expect((await syncPaneHomeSkill({}, dirs)).map(result => result.outcome)).toEqual(['removed', 'unchanged']);
    await plugin(false);
    expect((await syncPaneHomeSkill({}, dirs)).map(result => result.outcome)).toEqual(['written', 'unchanged']);
  });

  it('writes the pane-todos skill beside pane only while To-dos is on, and keeps To-dos out of pane (T-39)', async () => {
    const todosDirs = dirs.map(dir => path.join(path.dirname(dir), 'pane-todos'));
    await syncPaneHomeSkill({}, dirs);
    for (const dir of todosDirs) await expect(fs.access(dir)).rejects.toThrow();
    for (const dir of dirs) expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).not.toMatch(/to-do|todos|--todo/i);

    await syncPaneHomeSkill({ todosEnabled: true }, dirs);
    for (const dir of todosDirs) {
      const skill = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
      expect(skill).toContain('name: pane-todos');
      expect(skill).toContain('runpane report --state blocked --question "<question>" --todo T-n');
    }

    await syncPaneHomeSkill({ todosEnabled: false }, dirs);
    for (const dir of todosDirs) await expect(fs.access(dir)).rejects.toThrow();
  });

  it('follows the setting: on by default, off removes', async () => {
    expect((await syncPaneHomeSkill({}, dirs)).map(result => result.outcome)).toEqual(['written', 'written']);
    expect((await syncPaneHomeSkill({ agentContext: { managedAgentsMd: false, homeSkill: false } }, dirs))
      .map(result => result.outcome)).toEqual(['removed', 'removed']);
  });
});
