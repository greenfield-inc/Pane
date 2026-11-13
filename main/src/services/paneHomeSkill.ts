import { constants } from 'fs';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { AppConfig } from '../types/config';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { getAppDirectory } from '../utils/appDirectory';
import { linuxToUNCPath } from '../utils/wslUtils';
import { APPROVALS_RULES } from './approvalsRules';
import { agentsIntroForInstructions, scratchRule } from '../../../packages/runpane/src/paneIntro';
import { isPanePluginEnabled } from './claudePanePlugin';

/**
 * A user-level skill that teaches any agent in a Pane terminal how to reach
 * RunPane. It lives in the user's home skill folders (like Superset's) instead
 * of repository AGENTS.md files, so Pane never edits a user's repo to be found.
 * Only files carrying this marker are Pane's; everything else is left alone.
 * Bump the version when the skill changes shape: a copy marked by an older Pane
 * is rewritten, and a copy marked by a newer Pane is left for that Pane.
 */
const PANE_MANAGED_SKILL_VERSION = 4;
export const PANE_MANAGED_SKILL_MARKER = `<!-- pane-managed-skill v${PANE_MANAGED_SKILL_VERSION} -->`;
const MANAGED_MARKER_PATTERN = /<!-- pane-managed-skill v(\d+) -->/;
const SKILL_DIR_NAME = 'pane';
const SKILL_FILE = 'SKILL.md';
const execFileAsync = promisify(execFile);
let syncQueue: Promise<void> = Promise.resolve();

type PaneHomeSkillOutcome = 'written' | 'unchanged' | 'removed' | 'absent' | 'user-owned' | 'newer' | 'unsafe';

export interface PaneHomeSkillResult {
  skillPath: string;
  outcome: PaneHomeSkillOutcome;
}

export function isPaneHomeSkillEnabled(config: Pick<AppConfig, 'agentContext'>): boolean {
  return config.agentContext?.homeSkill !== false;
}

/**
 * Claude reads user skills from its config directory (CLAUDE_CONFIG_DIR when
 * set); Codex and other agents read ~/.agents/skills, which is where Superset
 * installs for them too.
 */
export function paneHomeSkillDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const claudeRoot = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
  return [
    path.join(claudeRoot, 'skills', SKILL_DIR_NAME),
    path.join(home, '.agents', 'skills', SKILL_DIR_NAME),
  ];
}

export function paneWslHomeSkillDirs(distro: string, home: string, claudeConfigDir = path.posix.join(home, '.claude')): string[] {
  return [
    linuxToUNCPath(path.posix.join(claudeConfigDir, 'skills', SKILL_DIR_NAME), distro),
    linuxToUNCPath(path.posix.join(home, '.agents', 'skills', SKILL_DIR_NAME), distro),
  ];
}

async function resolveWslHomeSkillDirs(distro: string): Promise<string[]> {
  const { stdout } = await execFileAsync('wsl.exe', [
    '-d', distro, '--', 'bash', '-lc',
    'printf "%s\\n%s\\n" "$HOME" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
  ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const [home, claudeConfigDir] = stdout.trim().split(/\r?\n/).map(value => value.trim());
  if (!home?.startsWith('/') || !claudeConfigDir?.startsWith('/')) {
    throw new Error(`Could not resolve skill directories in WSL distro ${distro}`);
  }
  return paneWslHomeSkillDirs(distro, home, claudeConfigDir);
}

function wslDistroRecordPath(): string {
  return path.join(getAppDirectory(), 'skills', 'wsl-distros.json');
}

async function readWslDistroRecord(): Promise<string[]> {
  try {
    return decodeBoundary(JSON.parse(await fs.readFile(wslDistroRecordPath(), 'utf8')), boundary.array(boundary.string));
  } catch {
    return [];
  }
}

async function writeWslDistroRecord(distros: string[]): Promise<void> {
  const recordPath = wslDistroRecordPath();
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, `${JSON.stringify(distros)}\n`, 'utf8');
}

export function syncPaneHomeSkill(
  config: Pick<AppConfig, 'agentContext'>,
  dirs: string[] = paneHomeSkillDirs(),
  wslDistros: string[] = [],
): Promise<PaneHomeSkillResult[]> {
  // PANE_DIR isolates app data, not the user's agent configuration. Test/dev
  // runtimes that disable OS integration must also leave these home files alone.
  if (process.env.PANE_DISABLE_OS_INTEGRATION === '1') return Promise.resolve([]);
  const result = syncQueue.then(() => syncPaneHomeSkillNow(config, dirs, wslDistros));
  syncQueue = result.then(() => {}, () => {});
  return result;
}

async function syncPaneHomeSkillNow(
  config: Pick<AppConfig, 'agentContext'>,
  dirs: string[],
  wslDistros: string[],
): Promise<PaneHomeSkillResult[]> {
  const enabled = isPaneHomeSkillEnabled(config);
  // Pane's Claude plugin carries this skill, so Claude's copy steps aside while the plugin is on.
  const claudeDir = paneHomeSkillDirs()[0];
  const claudeSettings = path.join(path.dirname(path.dirname(claudeDir)), 'settings.json');
  const retired = enabled && dirs.includes(claudeDir) && await isPanePluginEnabled(claudeSettings) ? claudeDir : undefined;
  const results: PaneHomeSkillResult[] = [];
  for (const dir of dirs) {
    results.push(...(enabled && dir !== retired ? await installPaneHomeSkill([dir]) : await removePaneHomeSkill([dir])));
  }
  if (process.platform !== 'win32') return results;

  const recorded = await readWslDistroRecord();
  const distros = [...new Set(enabled ? wslDistros : [...recorded, ...wslDistros])];
  if (enabled) await writeWslDistroRecord([...new Set([...recorded, ...wslDistros])]);
  const failed: string[] = [];
  for (const distro of distros) {
    try {
      const wslDirs = await resolveWslHomeSkillDirs(distro);
      results.push(...(enabled ? await installPaneHomeSkill(wslDirs) : await removePaneHomeSkill(wslDirs)));
    } catch (error) {
      failed.push(distro);
      console.warn(`[PaneHomeSkill] Could not sync skill in WSL distro ${distro}:`, error);
    }
  }
  if (!enabled) await writeWslDistroRecord(failed);
  return results;
}

export async function installPaneHomeSkill(dirs: string[] = paneHomeSkillDirs()): Promise<PaneHomeSkillResult[]> {
  const content = buildPaneHomeSkill();
  const results: PaneHomeSkillResult[] = [];
  for (const dir of dirs) {
    const skillPath = path.join(dir, SKILL_FILE);
    const dirKind = await entryKind(dir);
    if (dirKind === 'other') {
      results.push({ skillPath, outcome: 'unsafe' });
      continue;
    }
    if (dirKind === 'directory') {
      const existing = await readManagedFile(skillPath);
      if (existing.kind !== 'managed' && existing.kind !== 'missing') {
        results.push({ skillPath, outcome: existing.kind });
        continue;
      }
      // An existing folder without our marked file belongs to the user,
      // even when it is empty.
      if (existing.kind === 'missing') {
        results.push({ skillPath, outcome: 'user-owned' });
        continue;
      }
      if (existing.kind === 'managed' && existing.content === content) {
        results.push({ skillPath, outcome: 'unchanged' });
        continue;
      }
    } else {
      await fs.mkdir(dir, { recursive: true });
    }
    await replaceFile(skillPath, content);
    results.push({ skillPath, outcome: 'written' });
  }
  return results;
}

export async function removePaneHomeSkill(dirs: string[] = paneHomeSkillDirs()): Promise<PaneHomeSkillResult[]> {
  const results: PaneHomeSkillResult[] = [];
  for (const dir of dirs) {
    const skillPath = path.join(dir, SKILL_FILE);
    const dirKind = await entryKind(dir);
    if (dirKind === 'missing') {
      results.push({ skillPath, outcome: 'absent' });
      continue;
    }
    if (dirKind === 'other') {
      results.push({ skillPath, outcome: 'unsafe' });
      continue;
    }
    const existing = await readManagedFile(skillPath);
    if (existing.kind === 'missing') {
      results.push({ skillPath, outcome: 'absent' });
      continue;
    }
    if (existing.kind !== 'managed') {
      results.push({ skillPath, outcome: existing.kind });
      continue;
    }
    await fs.unlink(skillPath);
    // Keep the folder if the user added anything next to our file.
    if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
    results.push({ skillPath, outcome: 'removed' });
  }
  return results;
}

async function entryKind(target: string): Promise<'missing' | 'directory' | 'other'> {
  try {
    const stat = await fs.lstat(target);
    // A symlinked folder may point anywhere; never write through it.
    return stat.isDirectory() && !stat.isSymbolicLink() ? 'directory' : 'other';
  } catch (error) {
    if (decodeErrorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
}

type ManagedFile =
  | { kind: 'missing' }
  | { kind: 'managed'; content: string }
  | { kind: 'user-owned' }
  | { kind: 'newer' }
  | { kind: 'unsafe' };

async function readManagedFile(filePath: string): Promise<ManagedFile> {
  try {
    if ((await fs.lstat(filePath)).isSymbolicLink()) return { kind: 'unsafe' };
  } catch (error) {
    if (decodeErrorCode(error) === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = decodeErrorCode(error);
    if (code === 'ENOENT') return { kind: 'missing' };
    // ELOOP: the file is a symlink.
    if (code === 'ELOOP') return { kind: 'unsafe' };
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) return { kind: 'unsafe' };
    const content = await handle.readFile('utf8');
    const version = MANAGED_MARKER_PATTERN.exec(content)?.[1];
    if (version === undefined) return { kind: 'user-owned' };
    return Number(version) > PANE_MANAGED_SKILL_VERSION ? { kind: 'newer' } : { kind: 'managed', content };
  } finally {
    await handle.close();
  }
}

/** Write beside the target and rename over it, so readers never see a partial file. */
async function replaceFile(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, { mode: 0o644, flag: 'wx' });
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

/** Node's fs errors carry a string `code`; anything else has none. */
const decodeErrorCode = (error: Parameters<typeof decodeBoundary>[0]): string | undefined => {
  try {
    return decodeBoundary(error, boundary.object({ code: boundary.optional(boundary.string) })).code;
  } catch {
    return undefined;
  }
};

export function buildPaneHomeSkill(): string {
  return `---
name: pane
description: Use whenever you work with Pane (the desktop app that runs coding agents in parallel git worktrees) through runpane or the pane MCP: in a Pane terminal (PANE_SESSION_ID is set), for Panes, panels, Sessions, agent tabs, asking the person (notify), showing a page, reading or sending to another panel, reaching another machine, or when runpane or the pane tools seem missing.
---
${PANE_MANAGED_SKILL_MARKER}

# Pane

${agentsIntroForInstructions()}

- ${scratchRule()}

You drive all of it through the \`runpane\` CLI. \`runpane doctor\` prints the
full working rules.

## Establish the control surface

1. Check for \`runpane\` on PATH. If it is absent, use Pane's bundled CLI in
   its place: \`"$PANE_RUNPANE_BIN"\`, else \`~/.pane/bin/runpane\` (or
   \`$PANE_DIR/bin\`; \`runpane.cmd\` on Windows). Only when neither exists, use
   \`npx --yes runpane@latest\` in place of \`runpane\` in every command below.
2. Run \`runpane doctor --json\`, then \`runpane agent-context --json\`. For a
   command's exact schema, run \`runpane agent-context --command "<command>" --json\`.
3. If runpane cannot be reached or doctor fails, stop and tell the user what
   failed. Do not substitute raw \`git worktree\` checkouts or built-in
   subagents for work that belongs in a Pane, and do not invent commands.
   From WSL when Pane runs on Windows, a Linux wrapper cannot reach the
   Windows named-pipe daemon. Use Pane's own shim, which runs the Windows CLI
   through WSL interop: \`/mnt/c/Users/<you>/.pane/bin/runpane doctor --json\`
   (Pane's WSL terminals already have it on PATH). With an older Pane, use
   \`powershell.exe -NoProfile -Command 'Set-Location $env:TEMP; runpane doctor --json'\`
   and that form for subsequent commands.

## Common commands

- Find a repository: \`runpane repos list --json\`
- First check whether the work's branch already has a Pane: \`runpane panes list --repo <repo> --json\`, matching the PR's head branch against \`git -C <worktreePath> branch --show-current\`. If it does, use the tab command below.
- Start work whose branch has no Pane yet in a new Pane:
  \`runpane panes create --repo <repo> --name <name> --agent <codex|claude|cursor> --prompt "<task>" --source agent --no-focus --wait-ready --yes --json\`
- For work that already has a Pane (review, audit, fixes, QA), open a new agent tab in that Pane, never a new Pane. Inside a Pane, \`$PANE_SESSION_ID\` is that Pane's id:
  \`runpane panels create --pane <pane-id> --agent <codex|claude|cursor> --initial-input "<task>" --source agent --no-focus --wait-ready --yes --json\`
- When \`runpane agent-context --command "panels open" --json\` lists the
  command, show the user a page or file with
  \`runpane panels open --file <path> --source agent --yes --json\` or
  \`runpane panels open --url <url> --source agent --yes --json\`.
- Inspect a Pane: \`runpane panes list --json\`, \`runpane panels list --pane <pane-id> --json\`
- Read or wait on a panel: \`runpane panels screen --panel <panel-id> --limit 80 --json\`,
  \`runpane panels wait --panel <panel-id> --for idle --json\`
- Send a message: \`runpane panels submit --panel <panel-id> --text "<message>" --yes --json\`
- Wait for workers with the one wait primitive, run as a background task that
  wakes you when it exits; act on its event, then run it again (the named
  cursor misses nothing in between). Use \`--pane <pane-id>\` instead of
  \`--session\` outside a Session:
  \`runpane watch --session <session> --as <your-name> --until-event --json --kinds agent.report,agent.report.missing,agent.blocked,agent.ready,panel.exited,panel.stopped,panel.paused,pane.gone\`
  Never pipe \`runpane watch --follow\` into \`grep -m1\` or \`head\` to wait:
  \`--follow\` never exits on news.
- Workers end with \`runpane report --state <ready|blocked|failed|done> --summary-file <path>\`
  (\`--question\` when blocked, \`--pr\` and \`--head\` when there is a PR).

## With the pane MCP tools

When the \`pane\` MCP tools are loaded, use them for the jobs above:
\`agents_start\` starts an agent on a task, \`agents_status\` checks on it, and
\`agents_send\` sends it a follow-up, each in one call. Answer a menu in an
agent's terminal with \`panels_input\` \`keys\`, then check \`agents_status\`.
Show the user a page or file with \`panels_open\` rather than the system
browser. Before guessing how Pane works, call \`docs_search\`, then
\`docs_read\`. When you need the person, use \`notify\` as the next section says
rather than asking in the terminal.

${APPROVALS_RULES}

### Posting an approval card

Post it with the \`pane\` MCP \`notify\` tool. If the \`pane\` MCP tools are not
loaded (some launchers start agents with a strict MCP config), run the same
call through the CLI:
\`runpane notify --ui options --title "<question>" --context "<what it is for>" --choices '[{"label":"Ship it","detail":"<consequence>","recommended":true},{"label":"Wait"}]' --json\`.
\`--ui\` is \`options\`, \`approve\` (\`--detail\`), \`ask\` (\`--suggestions\`) or
\`info\`. On \`waiting\`, run \`runpane notify --resume <id> --json\`; on
\`unavailable\`, ask in the terminal. Related questions go in one options card:
\`--questions '[{"title":"<question>","choices":[...]},...]'\` (2 to 4, one
pick each) instead of \`--choices\`.

### Reading a reply

Picks alone come back as before: \`{answer}\`, or
\`answer: Q-n → <answer> (by you)\` in your tab. Anything typed comes back as a
reply: the open call's result \`{reply, picks?, id, replyId, next}\` (pass its
\`replyId\` to \`--took\` and \`--update\`: only your call was given it, so it works
from outside a Pane tab too), or this line in your tab:
\`reply: Q-n → "<their words>" (picked: <picks>) (by you)\` (\`(picked: …)\`
only when they picked something; without a Q-n it names the title and ends
\`[id <item id>]\`). A reply is an answer or a question about the approval,
and you decide which:

- **An answer:** run \`runpane notify --took <id|Q-n> answer --json\`, then act
  on it.
- **A question:** run \`runpane notify --took <id|Q-n> question --json\` at
  once (the approval reads "Getting more context…"; \`--status "<text>"\` says
  what you're doing instead). Find out, then run
  \`runpane notify --update <id|Q-n> --asked "<their question>" --what-changed "<one line per change>" --json\`
  with any changed \`--title\`, \`--context\`, \`--choices\`, \`--questions\` or
  \`--links\`. A reworded choice carries \`"was":"<old label>"\`. That saves a
  new version of the same approval, shown as "Updated · ready again"; never
  post a second approval for it. \`--update\` waits for the answer like a
  notify call.
- **The person can fix how you took it.**
  \`correction: Q-n → that was a question: "…" (by you)\` means treat it as a
  question: update the approval.
  \`correction: Q-n → that was your answer: "…" (by you)\` means it is recorded
  as the answer: act on it.

Only the reply's reader may run \`--took\` and \`--update\`: the asker, else the
orchestrator that relayed a worker's question, else Autopilot.

### Who asks, by role

- **A worker in a Session** (\`PANE_SESSION_DIR\` is set and
  \`PANE_ORCHESTRATION_SESSION_ID\` isn't, or your brief names an orchestrator
  or a parent status file) doesn't call \`notify\`. Run
  \`runpane report --state blocked --question "<question>"\` (with
  \`--summary-file <status file>\` when you keep one, after writing the
  question there). It shows at once in Approvals with an answer box, and it rings when
  your orchestrator relays it or after 10 minutes. The answer reaches this tab as
  \`answer: Q-n → <answer> (by you)\`; \`closed: Q-n (by you)\` and
  \`correction: Q-n → <answer> (by you)\` are the person's word too. A typed
  reply reaches this tab as a \`reply:\` line: read it as above (\`--took\` and
  \`--update\` aren't new asks, so a worker runs them).
- **A Session orchestrator** (\`PANE_ORCHESTRATION_SESSION_ID\` is set) keeps
  each item that waits on the person posted once, as a background
  \`runpane notify ... --links '<files>' --json\` titled with its Q-n, and
  stays free to talk: follow "What waits on the person" in
  \`runpane docs read --doc skills/pane-orchestration/SKILL.md\`. A reply to a
  worker's question it relayed comes to it when the worker can't read it.
- **Any other agent** calls \`notify\` as above.

### Secrets

For an API key, token or password, call the \`secrets_request\` tool (or
\`runpane secrets request --project <project> --name <NAME> --title "<text>" --reason "<what it is for>"\`),
never \`ask\`. Pane saves the value as a Pane secret and returns only saved or
declined; run commands with it through \`runpane secrets exec\`. If it returns
\`unavailable\`, ask the person to save it in Pane under Settings > Secrets.

## When something looks missing

- Pane keeps its data in \`~/.pane\` (or \`$PANE_DIR\`): \`bin/\` the CLI shims,
  \`logs/\` app logs, \`sessions/<id>/\` each Session's folder (plans, prompts,
  \`status/\` worker status files), \`skills/\` Pane's bundled skills, \`updates/\`.
- Which Pane and Session you are in: \`PANE_SESSION_ID\` (your Pane),
  \`PANE_PANEL_ID\`, \`PANE_ORCHESTRATION_SESSION_ID\`; then \`runpane panes list --json\`
  or \`runpane sessions overview --session <id> --json\` shows who owns what.
- Health and setup: \`runpane doctor --json\` names what is wrong and the fix.
- How something in Pane works: \`runpane docs search --query "<words>"\`, then
  \`runpane docs read --doc <path>\`.
- Another machine in the person's workspace: \`runpane workspace list\`, then
  \`runpane workspace <machine> exec -- <command>\`.

## Orchestrating workers

To launch, wait on, answer or resume workers (including wrappers launched with
\`--tool-command\`, such as \`agent-farm run\`), read and follow Pane's
orchestrator guide: \`runpane docs read --doc skills/pane-orchestration/SKILL.md\`.
It covers delivery checks, what each wake means, worker reports and status
files, resume after a restart, showing pages, and shared-checkout etiquette.

## Sessions

When \`PANE_ORCHESTRATION_SESSION_ID\` is set you are a Session orchestrator.
When \`panes create\` or \`panes adopt\` returns an \`association\` result,
check \`association.ok\`. Confirm with
\`runpane sessions overview --session "$PANE_ORCHESTRATION_SESSION_ID" --json\`.
If the Pane is absent, including when an older CLI returns no association
result, run \`runpane sessions associate --session "$PANE_ORCHESTRATION_SESSION_ID" --pane <pane-id> --json\`
and confirm again before sending work.
Never take over a Pane that belongs to another Session.

Opening a terminal or Session is not a request to start work. Act on the
user's request, and do not focus Pane windows unless the user asks.
`;
}
