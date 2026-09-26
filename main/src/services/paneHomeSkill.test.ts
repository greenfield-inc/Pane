import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PANE_MANAGED_SKILL_MARKER,
  buildPaneHomeSkill,
  installPaneHomeSkill,
  paneHomeSkillDirs,
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
    await fs.rm(home, { recursive: true, force: true });
  });

  const skillPath = (dir: string) => path.join(dir, 'SKILL.md');

  it('targets Claude user skills (honoring CLAUDE_CONFIG_DIR) and ~/.agents/skills', () => {
    expect(paneHomeSkillDirs({}, home)).toEqual([
      path.join(home, '.claude', 'skills', 'pane'),
      path.join(home, '.agents', 'skills', 'pane'),
    ]);
    expect(paneHomeSkillDirs({ CLAUDE_CONFIG_DIR: '/tmp/claude-alt' }, home)[0]).toBe(path.join('/tmp/claude-alt', 'skills', 'pane'));
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

  it('never overwrites or removes a skill the user wrote', async () => {
    await fs.mkdir(dirs[0], { recursive: true });
    await fs.writeFile(skillPath(dirs[0]), 'my own pane skill');
    await fs.mkdir(dirs[1], { recursive: true });
    await fs.writeFile(path.join(dirs[1], 'notes.md'), 'mine');

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
