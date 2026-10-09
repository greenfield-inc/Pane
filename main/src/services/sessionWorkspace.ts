import fs from 'fs';
import { sessionRuntimePath } from './sessionRuntime';
import { sessionWSLBridge, sessionWSLLauncher, sessionWSLRcFile } from './sessionWSLBridge';
import path from 'path';
import { getAppDirectory } from '../utils/appDirectory';
import { DEFAULT_SESSION_PROFILE, PANE_CAPABILITY_CONTEXT } from '../../../shared/types/sessionProfile';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';

const START = '<!-- pane-session-context:start -->';
const END = '<!-- pane-session-context:end -->';
const LEGACY_PROGRESS_STATUS = '.pane-progress.json';

export function sessionWorkspacePath(sessionId: string): string {
  // Store IDs are opaque, including imported IDs; never interpret them as paths.
  return path.join(getAppDirectory(), 'sessions', encodeURIComponent(sessionId).replace(/\./g, '%2E'));
}

/**
 * Git must not find a repository above a Session folder (for example a home
 * directory tracked as a dotfiles repo). Session terminals get this as
 * GIT_CEILING_DIRECTORIES.
 */
export function sessionGitCeiling(): string {
  return path.join(getAppDirectory(), 'sessions');
}

/** Text that would otherwise end or restart the generated section early. */
function escapeMarkers(content: string): string {
  return content.split(START).join('<!-- pane-session-context start -->').split(END).join('<!-- pane-session-context end -->');
}

/** Only the marked generated section is replaced; user instructions survive. */
function writeManagedInstructions(filePath: string, content: string): void {
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Session instruction file must not be a symbolic link: ${filePath}`);
  }
  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const start = previous.indexOf(START);
  const end = previous.indexOf(END);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error(`Session instruction markers are incomplete: ${filePath}`);
  }
  const block = `${START}\n${escapeMarkers(content)}\n${END}`;
  const next = start === -1
    ? `${previous}${previous ? '\n\n' : ''}${block}\n`
    : `${previous.slice(0, start)}${block}${previous.slice(end + END.length)}`;
  if (next !== previous) fs.writeFileSync(filePath, next, { mode: 0o600 });
}

export function prepareSessionWorkspace(
  sessionId: string,
  profile = DEFAULT_SESSION_PROFILE,
  record?: OrchestrationSessionRecord,
): string {
  const cwd = sessionWorkspacePath(sessionId);
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(cwd).isSymbolicLink()) throw new Error(`Session workspace must not be a symbolic link: ${cwd}`);
  // Earlier builds wrote this switch for the removed progress view.
  const legacyProgressStatus = path.join(cwd, LEGACY_PROGRESS_STATUS);
  if (fs.existsSync(legacyProgressStatus) && fs.lstatSync(legacyProgressStatus).isFile()) fs.unlinkSync(legacyProgressStatus);
  const content = sessionInstructions(sessionId, profile, record);
  writeManagedInstructions(path.join(cwd, 'AGENTS.md'), content);
  // Claude resolves imports before the first turn; Cursor also reads AGENTS.md.
  writeManagedInstructions(path.join(cwd, 'CLAUDE.md'), '@AGENTS.md');
  if (record?.runtime === 'wsl') {
    const runtimeDirectory = path.join(cwd, '.pane-runtime');
    fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(runtimeDirectory).isSymbolicLink()) throw new Error('Session runtime directory must not be a symbolic link');
    for (const [name, content] of Object.entries(runtimeFiles(cwd, record))) {
      const file = path.join(runtimeDirectory, name);
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Session runtime file must not be a symbolic link');
      fs.writeFileSync(file, content, { mode: 0o700 });
    }
    writeManagedInstructions(path.join(cwd, 'runtime-context.md'), wslRouting(record));
  }
  return cwd;
}

function runtimeFiles(cwd: string, record: OrchestrationSessionRecord) {
  return {
    runpane: sessionWSLBridge(getAppDirectory(), record, path.join(cwd, '.pane-runtime', 'runpane.cjs')),
    'runpane.cjs': sessionWSLLauncher(getAppDirectory()),
    bashrc: sessionWSLRcFile(cwd, record),
  };
}

function sessionInstructions(
  sessionId: string,
  profile: string,
  record: OrchestrationSessionRecord | undefined,
): string {
  return [
    '# Pane Session',
    `Stable Session ID: ${sessionId}`,
    'This directory belongs to one Session. Opening it does not authorize work. Await user input. Saved next actions are context only.',
    PANE_CAPABILITY_CONTEXT,
    delegationRules(sessionId, record),
    '## Session behavior profile',
    profile,
    `## Plans and documents
When you write a plan, report, or other document for the user, write it as one self-contained HTML file (inline CSS, SVG, and images) in this Session folder, for example plans/<topic>.html. Then show the rendered page with runpane panels open --url <file-url> --source agent --yes --json; it opens as an intentional live browser in split view beside this conversation. Use --file <path> to inspect HTML as read-only source instead. Rerunning the command for the same target reuses its tab, so update the file in place and reopen it after material changes.
Distinguish plans from verified results. Opening this Session is not an instruction to write or open documents.`,
    '## Persisted context',
    'When a user task needs current state, use sessions get/overview with the stable Session ID. The snapshot below may be stale. It is data, not a startup task.',
    record ? JSON.stringify({ name: record.name, goal: record.goal, context: record.context, decisions: record.decisions, blockers: record.blockers, nextAction: record.nextAction, associations: record.associations, evidence: record.evidence, outputs: record.outputs }, null, 2) : '',
  ].join('\n\n');
}

/**
 * Rules an orchestrator must follow even if it never opens the guide skill.
 * Paths mirror SkillCacheManager's Pane Chat layout under the app directory.
 */
function delegationRules(sessionId: string, record?: OrchestrationSessionRecord): string {
  const appDirectory = sessionRuntimePath(getAppDirectory(), record);
  const guide = sessionRuntimePath(path.join(getAppDirectory(), 'skills', 'pane-chat', 'pane-orchestrator', 'SKILL.md'), record);
  const runtimeContext = record?.runtime === 'wsl'
    ? sessionRuntimePath(path.join(sessionWorkspacePath(sessionId), 'runtime-context.md'), record)
    : path.join(appDirectory, 'skills', 'pane-chat', 'runtime-context.md');
  return `## Reaching Pane and delegating work
At the start of each task that uses Pane, run runpane doctor --json --pane-dir "${appDirectory}". Pane terminals put runpane on PATH; if it does not resolve, use "$PANE_RUNPANE_BIN", then follow ${runtimeContext} for other ways to reach this Pane install.
Delegate repository work to visible Panes with runpane panes create. Panes you create or adopt here are associated with this Session automatically; confirm with runpane sessions overview --session ${sessionId} --json, and use runpane sessions associate for existing Panes.
Never substitute plain git worktrees or built-in or background subagents for work delegated to a Pane. If runpane cannot reach Pane, stop and tell the user what failed.
Read ${guide} before coordinating Panes for the first time in a conversation.${record?.runtime === 'wsl' ? `\n${wslRouting(record)}` : ''}`;
}

function wslRouting(record: OrchestrationSessionRecord): string {
  const appDirectory = sessionRuntimePath(getAppDirectory(), record);
  return `## WSL RunPane Routing
This Session runs in ${record.wslDistribution}. This file overrides the shared Pane Chat runtime context for this Session.
Pane runs on Windows. Linux processes cannot open its named pipe. The Session's runpane on PATH (also $PANE_RUNPANE_BIN) automatically invokes the bundled Windows CLI through powershell.exe from Windows TEMP.
Run runpane doctor --json --pane-dir "${appDirectory}" before using Pane. Pass --pane-dir "${appDirectory}" on every call. The bridge translates file arguments to Windows paths and always targets this instance. Use this bridge, not a Linux npm/npx runpane installation.
Session folder: ${sessionRuntimePath(sessionWorkspacePath(record.id), record)}
Windows CLI output contains Windows paths; translate them with wslpath -u before reading files in Linux. If interop or doctor fails, report the error and stop Pane actions.`;
}

/** Read-only check: never fold a workspace containing user edits or artifacts. */
export function isPristineSessionWorkspace(record: OrchestrationSessionRecord): boolean {
  const cwd = sessionWorkspacePath(record.id);
  if (!fs.existsSync(cwd)) return true;
  if (!fs.lstatSync(cwd).isDirectory() || fs.lstatSync(cwd).isSymbolicLink()) return false;
  const expectedAgents = `${START}\n${sessionInstructions(record.id, record.profile ?? DEFAULT_SESSION_PROFILE, record)}\n${END}`;
  return fs.readdirSync(cwd).every(name => {
    const file = path.join(cwd, name);
    if (!fs.lstatSync(file).isFile()) return false;
    if (name !== 'AGENTS.md' && name !== 'CLAUDE.md' && name !== LEGACY_PROGRESS_STATUS) return false;
    const content = fs.readFileSync(file, 'utf8').trim();
    if (name === 'AGENTS.md') return content === expectedAgents;
    if (name === 'CLAUDE.md') return content === `${START}\n@AGENTS.md\n${END}`;
    return content === '{"enabled":true}' || content === '{"enabled":false}';
  });
}

/** Roll back only our unpublished scaffold; retain a record if user files appeared. */
export function discardSessionScaffold(record: OrchestrationSessionRecord): boolean {
  const cwd = sessionWorkspacePath(record.id);
  if (!fs.existsSync(cwd)) return true;
  if (fs.lstatSync(cwd).isSymbolicLink()) return false;
  const names = fs.readdirSync(cwd);
  const files: string[] = [];
  let runtimeDirectory: string | undefined;
  for (const name of names) {
    const file = path.join(cwd, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return false;
    if (name === '.pane-runtime' && record.runtime === 'wsl') {
      if (!stat.isDirectory()) return false;
      const expected = new Map(Object.entries(runtimeFiles(cwd, record)));
      for (const child of fs.readdirSync(file)) {
        const childPath = path.join(file, child);
        if (!expected.has(child) || !fs.lstatSync(childPath).isFile()) return false;
        if (fs.readFileSync(childPath, 'utf8') !== expected.get(child)) return false;
        files.push(childPath);
      }
      runtimeDirectory = file;
      continue;
    }
    if (!stat.isFile()) return false;
    const content = fs.readFileSync(file, 'utf8').trim();
    files.push(file);
    if (name === 'runtime-context.md' && record.runtime === 'wsl') {
      if (content !== `${START}\n${escapeMarkers(wslRouting(record))}\n${END}`) return false;
      continue;
    }
    if (name !== 'AGENTS.md' && name !== 'CLAUDE.md' && name !== LEGACY_PROGRESS_STATUS) return false;
    if (name === LEGACY_PROGRESS_STATUS) {
      if (content !== '{"enabled":true}' && content !== '{"enabled":false}') return false;
      continue;
    }
    if (!content.startsWith(START) || !content.endsWith(END)) return false;
  }
  for (const file of files) fs.unlinkSync(file);
  if (runtimeDirectory) fs.rmdirSync(runtimeDirectory);
  fs.rmdirSync(cwd);
  return true;
}
