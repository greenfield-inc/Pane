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

  it('teaches every orchestrator to keep what waits on the person posted to Approvals', async () => {
    const guide = (await fs.readFile(path.join(bundleRoot, 'skills', 'pane-orchestration', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
    expect(guide).toContain('## What waits on the person: Approvals');
    expect(guide).toContain("Keep every item that waits on the person posted to Pane's Approvals, exactly once.");
    expect(guide).toContain('You are in orchestrator mode');
    expect(guide).toContain('Approvals come from you, not from the agents in');
    expect(guide).toContain('either have an approval waiting for the person');
    expect(guide).toContain('or be done and say so.');
    expect(guide).toContain('pass the related files, PRs and pages as `--links`.');
    expect(guide).not.toMatch(/never (be )?stalled|Nothing left to do in this Session/i);
    expect(guide).toContain('Post with the CLI as a background command, one per item, so you stay free to talk');
    expect(guide).toContain('runpane notify --ui options --title "Q-7: <the question>"');
    expect(guide).toContain('(`runpane inbox ack <id>`)');
    expect(guide).toContain('stop its background command (TaskStop in Claude Code), which expires the card');
    expect(guide).toContain('Pane keeps no approvals across a restart, so after one, post each item that still waits again, exactly once.');
    expect(guide).toContain('ask in this tab as before');
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
