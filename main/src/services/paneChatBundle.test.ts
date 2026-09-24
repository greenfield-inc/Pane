import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';

const bundleRoot = path.join(__dirname, 'paneChatBundle');

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return Promise.resolve(entry.name.endsWith('.md') ? [full] : []);
  }));
  return nested.flat();
}

describe('Pane Chat skill bundle', () => {
  it('names every skill after its folder', async () => {
    const skills = await fs.readdir(path.join(bundleRoot, 'skills'));
    for (const skill of skills) {
      const text = await fs.readFile(path.join(bundleRoot, 'skills', skill, 'SKILL.md'), 'utf8');
      expect(/^---\nname: (\S+)/.exec(text)?.[1], skill).toBe(skill);
    }
  });

  it('resolves every relative markdown link', async () => {
    for (const file of await markdownFiles(bundleRoot)) {
      const text = await fs.readFile(file, 'utf8');
      for (const match of text.matchAll(/\]\((\.{1,2}\/[^)#\s]+|[\w-]+\/[^)#\s]+\.md|[\w-]+\.md)\)/g)) {
        await expect(fs.access(path.resolve(path.dirname(file), match[1])), `${file} -> ${match[1]}`).resolves.toBeUndefined();
      }
    }
  });

  it('gives each helper subagent a bundled skill', async () => {
    for (const agent of await fs.readdir(path.join(bundleRoot, 'agents'))) {
      const text = await fs.readFile(path.join(bundleRoot, 'agents', agent), 'utf8');
      const skill = /^skill: (\S+)$/m.exec(text)?.[1];
      expect(skill, agent).toBeDefined();
      await expect(fs.access(path.join(bundleRoot, 'skills', skill!, 'SKILL.md'))).resolves.toBeUndefined();
    }
  });
});
