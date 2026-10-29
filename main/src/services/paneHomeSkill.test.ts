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

  it('follows the setting: on by default, off removes', async () => {
    expect((await syncPaneHomeSkill({}, dirs)).map(result => result.outcome)).toEqual(['written', 'written']);
    expect((await syncPaneHomeSkill({ agentContext: { managedAgentsMd: false, homeSkill: false } }, dirs))
      .map(result => result.outcome)).toEqual(['removed', 'removed']);
  });
});
