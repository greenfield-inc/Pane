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

  const statusPage = path.join(bundleRoot, 'skills', 'orchestrate-sessions', 'assets', 'status-page');
  async function renderStatusPage(statusFile: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'status-page-'));
    try {
      execFileSync(process.execPath, [path.join(statusPage, 'render.mjs'), statusFile, path.join(dir, 'index.html')]);
      return await fs.readFile(path.join(dir, 'index.html'), 'utf8');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it('renders the Session status page from bundled files alone, with nothing fetched', async () => {
    const html = await renderStatusPage(path.join(statusPage, 'example-status.json'));
    expect(html).toContain('Get PRs in (example)');
    expect(html).toContain('href="pane://open?pane=pane-1014&amp;panel=panel-impl"');
    expect(html).not.toMatch(/<script|<link\b|@import|(src|srcset|url)\s*\(?\s*=?\s*["']?https?:/i);
  });

  it('keeps script out of the status page whatever the status JSON holds', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'status-json-'));
    const statusFile = path.join(dir, 'status.json');
    await fs.writeFile(statusFile, JSON.stringify({
      session: { title: hostile, counts: { running: hostile } },
      needs: [{ id: null, q: hostile, link: 'javascript:alert(2)', files: 'data:text/html,x', why: 'w' }],
      items: [{ name: hostile, state: '"><script>alert(3)</script>', link: 'javascript:alert(4)', pr: '#1', prLink: 'javascript:alert(5)', paneLink: 'javascript:alert(6)' }],
      done: [{ label: 'x', link: 'javascript:alert(7)' }],
    }));
    try {
      const html = await renderStatusPage(statusFile);
      expect(html).not.toMatch(/<script>|<img|javascript:|data:text/i);
      expect(html).toContain('&lt;img src=x onerror=alert(1)>');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
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
