import { constants } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AppConfig } from '../types/config';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

/**
 * A user-level skill that teaches any agent in a Pane terminal how to reach
 * RunPane. It lives in the user's home skill folders (like Superset's) instead
 * of repository AGENTS.md files, so Pane never edits a user's repo to be found.
 * Only files carrying this marker are Pane's; everything else is left alone.
 */
export const PANE_MANAGED_SKILL_MARKER = '<!-- pane-managed-skill v1 -->';
const SKILL_DIR_NAME = 'pane';
const SKILL_FILE = 'SKILL.md';

type PaneHomeSkillOutcome = 'written' | 'unchanged' | 'removed' | 'absent' | 'user-owned' | 'unsafe';

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

export async function syncPaneHomeSkill(
  config: Pick<AppConfig, 'agentContext'>,
  dirs: string[] = paneHomeSkillDirs(),
): Promise<PaneHomeSkillResult[]> {
  return isPaneHomeSkillEnabled(config) ? installPaneHomeSkill(dirs) : removePaneHomeSkill(dirs);
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
      // A folder without our SKILL.md may be the user's own `pane` skill.
      if (existing.kind === 'missing' && (await fs.readdir(dir)).length > 0) {
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
  | { kind: 'unsafe' };

async function readManagedFile(filePath: string): Promise<ManagedFile> {
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
    return content.includes(PANE_MANAGED_SKILL_MARKER) ? { kind: 'managed', content } : { kind: 'user-owned' };
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
description: Use Pane from inside a Pane terminal (PANE_SESSION_ID is set) through the runpane CLI. Use when delegating work to agents in their own Panes and worktrees, showing the user an HTML page, plan, report, local server, or file beside the conversation, reading or sending input to another panel, or coordinating Panes from a Session orchestrator.
---
${PANE_MANAGED_SKILL_MARKER}

# Pane

Pane runs agents in terminal panels grouped into Panes, each Pane with its own
worktree. Sessions are orchestrator conversations that own Panes. You drive all
of it through the \`runpane\` CLI.

## Establish the control surface

1. Resolve the CLI: \`command -v runpane\`, else \`"$PANE_RUNPANE_BIN"\`.
2. Run \`runpane doctor --json\`, then \`runpane agent-context --json\`. For a
   command's exact schema, run \`runpane agent-context --command "<command>" --json\`.
3. If runpane cannot be reached or doctor fails, stop and tell the user what
   failed. Do not substitute raw \`git worktree\` checkouts or built-in
   subagents for work that belongs in a Pane, and do not invent commands.

## Common commands

- Find a repository: \`runpane repos list --json\`
- Delegate work in a new Pane:
  \`runpane panes create --repo <repo> --name <name> --agent <codex|claude|cursor> --prompt "<task>" --source agent --no-focus --wait-ready --yes --json\`
- Show the user a page, plan, report, local server, or file:
  \`runpane panels open --file <path> --source agent --yes --json\` or \`--url <url>\`.
  It opens beside the conversation in split view by default (\`--tab\` for a plain
  tab). HTML files render in a browser tab. Reopening the same file reuses and
  reloads its tab.
- Inspect a Pane: \`runpane panes list --json\`, \`runpane panels list --pane <pane-id> --json\`
- Read or wait on a panel: \`runpane panels screen --panel <panel-id> --limit 80 --json\`,
  \`runpane panels wait --panel <panel-id> --for idle --json\`
- Send a message: \`runpane panels submit --panel <panel-id> --text "<message>" --yes --json\`

## Sessions

When \`PANE_ORCHESTRATION_SESSION_ID\` is set you are a Session orchestrator.
Panes you create or adopt with \`panes create\` or \`panes adopt\` are
associated with the Session automatically; each returned item carries
\`association: { sessionId, ok, error? }\`. Check \`association.ok\`, or confirm
with \`runpane sessions overview --session "$PANE_ORCHESTRATION_SESSION_ID" --json\`.
Run \`runpane sessions associate --session "$PANE_ORCHESTRATION_SESSION_ID" --pane <pane-id> --json\`
only for a Pane that already existed or when automatic association failed.
Never take over a Pane that belongs to another Session.

Opening a terminal or Session is not a request to start work. Act on the
user's request, and do not focus Pane windows unless the user asks.
`;
}
