import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureProjectAgentContext,
  PANE_AGENT_CONTEXT_END,
  PANE_AGENT_CONTEXT_START,
} from './agentContextManager';

const tempDirs: string[] = [];

async function createTempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-agent-context-'));
  tempDirs.push(dir);
  return dir;
}

describe('agentContextManager', () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('does not create project instruction files', async () => {
    const projectPath = await createTempProject();
    await ensureProjectAgentContext({ path: projectPath });
    expect(await fs.readdir(projectPath)).toEqual([]);
  });

  it('removes only paired Pane blocks, preserving user instructions and imports', async () => {
    const projectPath = await createTempProject();
    const block = `${PANE_AGENT_CONTEXT_START}\nOld generated content\n${PANE_AGENT_CONTEXT_END}\n`;
    for (const name of ['agents.md', 'CLAUDE.md']) {
      await fs.writeFile(path.join(projectPath, name), `User preface.\n${block}User footer.\n@my-rules.md\n`);
    }
    await ensureProjectAgentContext({ path: projectPath });
    await ensureProjectAgentContext({ path: projectPath });
    for (const name of ['agents.md', 'CLAUDE.md']) {
      expect(await fs.readFile(path.join(projectPath, name), 'utf8')).toBe('User preface.\nUser footer.\n@my-rules.md\n');
    }
  });

  it('leaves user files and incomplete markers unchanged', async () => {
    const projectPath = await createTempProject();
    const content = `User instructions\n${PANE_AGENT_CONTEXT_START}\nUnpaired marker`;
    await fs.writeFile(path.join(projectPath, 'AGENTS.md'), content);
    await fs.writeFile(path.join(projectPath, 'CLAUDE.md'), '@AGENTS.md\nUser import');
    expect((await ensureProjectAgentContext({ path: projectPath })).changed).toBe(false);
    expect(await fs.readFile(path.join(projectPath, 'AGENTS.md'), 'utf8')).toBe(content);
    expect(await fs.readFile(path.join(projectPath, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\nUser import');
  });

  it('retains a file that contained only a generated block', async () => {
    const projectPath = await createTempProject();
    const file = path.join(projectPath, 'AGENTS.md');
    await fs.writeFile(file, `${PANE_AGENT_CONTEXT_START}\nGenerated\n${PANE_AGENT_CONTEXT_END}\n`);
    await ensureProjectAgentContext({ path: projectPath });
    expect(await fs.readFile(file, 'utf8')).toBe('');
  });

  it('does not follow symlinked AGENTS.md files', async () => {
    const projectPath = await createTempProject();
    const outsidePath = await createTempProject();
    const targetPath = path.join(outsidePath, 'outside-agents-target');
    const agentsPath = path.join(projectPath, 'AGENTS.md');
    await fs.writeFile(targetPath, 'outside file\n', 'utf8');

    try {
      await fs.symlink(targetPath, agentsPath);
    } catch {
      return;
    }

    const result = await ensureProjectAgentContext({ path: projectPath });

    expect(result).toMatchObject({ changed: false, skipped: 'unsafe-file' });
    await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('outside file\n');
  });
});
