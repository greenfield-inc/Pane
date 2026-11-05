import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
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

  it('ships the orchestrator guide', async () => {
    await expect(fs.access(path.join(bundleRoot, 'skills', 'pane-orchestration', 'SKILL.md'))).resolves.toBeUndefined();
  });

  it('renders the Session status page from bundled files alone, with nothing fetched', async () => {
    const statusPage = path.join(bundleRoot, 'skills', 'orchestrate-sessions', 'assets', 'status-page');
    const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'status-page-')), 'index.html');
    execFileSync(process.execPath, [path.join(statusPage, 'render.mjs'), path.join(statusPage, 'example-status.json'), out]);
    const html = await fs.readFile(out, 'utf8');
    expect(html).toContain('Get PRs in (example)');
    expect(html).toContain('href="pane://open?pane=pane-1014&amp;panel=panel-impl"');
    expect(html).not.toMatch(/<script|<link\b|@import|(src|url)\(?=?["']?https?:/i);
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
