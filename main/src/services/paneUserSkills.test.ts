import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncPaneUserSkills, type UserSkillTarget } from './paneUserSkills';

const dirs: string[] = [];
const name = 'pane-manage-and-message-agents';
async function target(client: UserSkillTarget['client'] = 'Cursor'): Promise<UserSkillTarget> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-user-skill-'));
  dirs.push(home);
  return { client, skillsRoot: path.join(home, client === 'Cursor' ? '.cursor' : client === 'Codex' ? '.codex' : '.claude', 'skills') };
}
const skillFile = (item: UserSkillTarget) => path.join(item.skillsRoot, name, 'SKILL.md');

describe('Pane user skills', () => {
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('installs the exact skill in Cursor user skills, then leaves the second sync unchanged and removes it', async () => {
    const item = await target();
    await syncPaneUserSkills([item], true);
    const first = await fs.readFile(skillFile(item), 'utf8');
    expect(first).toContain('name: pane-manage-and-message-agents\n');
    expect(first).toContain('You coordinate. Another agent in a Pane does the work.');
    const stat = await fs.stat(skillFile(item));
    await syncPaneUserSkills([item], true);
    expect((await fs.stat(skillFile(item))).mtimeMs).toBe(stat.mtimeMs);
    await syncPaneUserSkills([item], false);
    await expect(fs.stat(skillFile(item))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a hand-added skill alone when enabled and disabled', async () => {
    const item = await target('Codex');
    await fs.mkdir(path.dirname(skillFile(item)), { recursive: true });
    await fs.writeFile(skillFile(item), 'user skill\n');
    await syncPaneUserSkills([item], true);
    await syncPaneUserSkills([item], false);
    expect(await fs.readFile(skillFile(item), 'utf8')).toBe('user skill\n');
  });

  it('preserves a symlinked skill file and leaves edits to a managed copy alone', async () => {
    const item = await target('Claude Code');
    await syncPaneUserSkills([item], true);
    const actual = path.join(path.dirname(skillFile(item)), 'actual.md');
    await fs.rename(skillFile(item), actual);
    await fs.symlink(actual, skillFile(item));
    await syncPaneUserSkills([item], true);
    expect((await fs.lstat(skillFile(item))).isSymbolicLink()).toBe(true);
    await fs.writeFile(actual, 'my edit\n');
    await syncPaneUserSkills([item], false);
    expect(await fs.readFile(actual, 'utf8')).toBe('my edit\n');
  });
});
