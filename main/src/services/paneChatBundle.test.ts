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
    expect(guide).toContain('Post or relay with the CLI as a background command, one per item, so you stay free to talk');
    expect(guide).toContain('runpane notify --ui options --title "Q-7: <the question>"');
    expect(guide).toContain('`runpane notify --relays <item>`');
    expect(guide).toContain('`runpane inbox ack <item> --decision <D-n>`');
    expect(guide).toContain('`correction: Q-n → <answer> (by you)`');
    expect(guide).toContain('stop its background command (TaskStop in Claude Code)');
    expect(guide).toContain('Approvals survive a restart');
    expect(guide).not.toContain('Pane keeps no approvals');
    expect(guide).toContain('ask in this tab as before');
  });

  it('archives without asking only inside a Session; outside one, archiving still needs approval (D-96)', async () => {
    for (const file of await markdownFiles(bundleRoot)) {
      const text = (await fs.readFile(file, 'utf8')).replace(/\s+/g, ' ');
      // Every sentence that ties archiving to approval is about working outside a Session.
      for (const sentence of text.split(/(?<=\.)\s/)) {
        if (/archiv[^.]*approv|approv[^.]*archiv/i.test(sentence)) expect(sentence, file).toMatch(/Outside a Session/);
      }
      expect(text, file).not.toContain('approval before destructive cleanup');
    }
    const orchestration = (await fs.readFile(path.join(bundleRoot, 'skills', 'pane-orchestration', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
    expect(orchestration).toContain('This applies only to a Session orchestrator, and only to its own Session\'s Panes and tabs.');
    expect(orchestration).not.toContain('"the Session" means the Panes and tabs you started');
    const runpane = (await fs.readFile(path.join(bundleRoot, 'skills', 'runpane', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
    expect(runpane).toContain('As a Session orchestrator, archive a feature Pane of your own Session without asking');
    expect(runpane).toContain('Outside a Session, archiving removes a Pane\'s worktree, so it needs the user\'s cleanup approval');
  });

  it('replaces Clean up with the Keep the Session tidy rules', async () => {
    const text = (await fs.readFile(path.join(bundleRoot, 'skills', 'pane-orchestration', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
    expect(text).not.toContain('## Clean up');
    expect(text).toContain('## Keep the Session tidy');
    expect(text).toContain('Keep one status document for this Session, in the Session folder, and update it in place.');
    expect(text).toContain('Link plans, PRs, mock-ups, reports and other pages from it instead of opening each one.');
    expect(text).toContain('runpane panels close --panel <id> --yes --json');
    expect(text).toContain('runpane panes archive --pane <id> --dry-run --json');
    expect(text).toContain('runpane panes archive --session <S> --merged --closed --dry-run --json');
    expect(text).toContain('Never pass `--force`.');
    expect(text).toContain('[/wrap-up](../wrap-up/SKILL.md)');
    // A worker's untracked status file elsewhere in the worktree would keep its Pane from archiving.
    expect(text).toContain('An untracked file anywhere else in the worktree makes the archive dry run unclean and keeps the Pane.');
    const runpane = (await fs.readFile(path.join(bundleRoot, 'skills', 'runpane', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
    expect(runpane).toContain('--merged --closed --dry-run --json');
    expect(runpane).toContain('Never pass `--force`.');
  });

  it('ships /wrap-up with every step of the guide', async () => {
    const text = (await fs.readFile(path.join(bundleRoot, 'skills', 'wrap-up', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
    expect(text).toContain('runpane sessions overview --session "$PANE_ORCHESTRATION_SESSION_ID" --json');
    // D-107: the person hears about what needs attention before anything is archived, and is never asked to choose.
    expect(text.indexOf('## 2. Tell the person first, if anything needs attention')).toBeLessThan(text.indexOf('## 3. Archive what is safe'));
    expect(text).toContain('runpane notify --ui info --title "Wrapping up: N things need attention"');
    expect(text).toContain('every item on the card, worded the same.');
    expect(text).toContain('This is a notice, not a question: /wrap-up asks nothing and doesn\'t wait for an answer.');
    expect(text).not.toContain('Keep going, or stop?');
    // D-107: the Session is never archived by /wrap-up; its report stays readable in the open Session.
    expect(text).not.toContain('{"archived":true}');
    expect(text).not.toMatch(/## \d\. Archive the Session/);
    expect(text).toContain('Never archive the Session itself, and never run `runpane sessions update` with `archived`: that is the person\'s action.');
    expect(text).toContain('that the Session stays open, and the person can archive it from the sidebar');
    expect(text).toContain('Nothing left to do in this Session.');
    expect(text).toContain('Never skip this, even when everything was archived and nothing was kept.');
    // A busy worker keeps its Pane until it finishes; nothing is forced.
    expect(text).toContain('A worker still working (`agent-busy`) is left to finish: keep its Pane and its work-list item.');
    expect(text).toContain('runpane panels wait --panel <id> --for idle --json');
    // sessions overview's PR state is cached and can still say open right after a merge.
    expect(text).toContain('which asks GitHub now (`items[].pr`), not from `sessions overview`');
    expect(text).toContain('runpane panes restore');
    expect(text).toContain('/wrap-up never merges a PR, commits or pushes for a worker, passes `--force`, deletes a branch, closes a tab the person opened, archives the Session, or touches a Pane or tab outside this Session');
    // The Session folder copy has to work on its own.
    expect(text).not.toMatch(/\]\(\.{0,2}\//);
  });

  it('teaches Autopilot its rules for approvals, with permission prompts left to the person', async () => {
    const guide = (await fs.readFile(path.join(bundleRoot, 'skills', 'pane-autopilot', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
    for (const command of ['runpane autopilot close <id> --reason', 'runpane autopilot rewrite <id>', 'runpane autopilot answer <id>', '--because "<D-n, document or their words>"']) {
      expect(guide).toContain(command);
    }
    expect(guide).toContain('the way forward is clear **and** the item relates to what you are working on with the person, or when the person told you to handle approvals');
    expect(guide).toContain('**Never** a permission prompt');
    expect(guide).toContain('`runpane autopilot waiting --json` **is** your queue');
    expect(guide).toContain('bring one group at a time');
    expect(guide).toContain('"Can\'t see: <machine>"');
    expect(guide).toContain('"<machine> offline"');
    expect(guide).not.toContain('D-66');
    expect(guide).not.toMatch(/never answers? an approval/i);
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
