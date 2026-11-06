import fs from 'fs';
import { sessionRuntimePath } from './sessionRuntime';
import { sessionWSLBridge, sessionWSLLauncher, sessionWSLRcFile } from './sessionWSLBridge';
import path from 'path';
import { getAppDirectory } from '../utils/appDirectory';
import { DEFAULT_SESSION_PROFILE, PANE_CAPABILITY_CONTEXT } from '../../../shared/types/sessionProfile';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { keepSessionTidySection } from './sessionTidyRules';

const START = '<!-- pane-session-context:start -->';
const END = '<!-- pane-session-context:end -->';
const LEGACY_PROGRESS_STATUS = '.pane-progress.json';
/**
 * /wrap-up ships in the Pane Chat bundle and is copied into each Session folder,
 * where only that Session's orchestrator finds it: Claude Code reads the
 * starting folder's .claude/skills (typed as /wrap-up) and Codex its
 * .agents/skills. Workers start in their worktrees; their read access to the
 * Session folder (permissions.additionalDirectories) loads no skills.
 */
const WRAP_UP_SKILL_SOURCE = path.join(__dirname, 'paneChatBundle', 'skills', 'wrap-up', 'SKILL.md');
const SESSION_SKILL_FOLDERS = ['.claude', '.agents'] as const;
const WRAP_UP_SKILL_PATH = ['skills', 'wrap-up', 'SKILL.md'] as const;
const MANAGED_SKILL_MARKER = '<!-- Pane writes this file into each Session folder and rewrites it on launch. -->';

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
  writeWrapUpSkills(cwd);
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

/** The Session folder's copy of the bundled /wrap-up guide, or undefined when the bundle is unreadable. */
function managedWrapUpSkill(): string | undefined {
  try {
    const bundled = fs.readFileSync(WRAP_UP_SKILL_SOURCE, 'utf8');
    return bundled.replace(/^(---\n[\s\S]*?\n---\n)/, `$1\n${MANAGED_SKILL_MARKER}\n`);
  } catch (error) {
    console.warn('[SessionWorkspace] Could not read the bundled /wrap-up skill', error);
    return undefined;
  }
}

function isSessionSkillFolder(name: string): boolean {
  return SESSION_SKILL_FOLDERS.some(folder => folder === name);
}

/** Real directories only: a symbolic link here could send the write outside the Session folder. */
function isPlainDirectoryOrMissing(directory: string): boolean {
  if (!fs.existsSync(directory)) return true;
  const stat = fs.lstatSync(directory);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

/** Writes /wrap-up for Claude Code and Codex; a copy the user rewrote (no marker) is left alone. */
function writeWrapUpSkills(cwd: string): void {
  const content = managedWrapUpSkill();
  if (!content) return;
  for (const folder of SESSION_SKILL_FOLDERS) {
    const file = path.join(cwd, folder, ...WRAP_UP_SKILL_PATH);
    const directories = [path.join(cwd, folder), path.join(cwd, folder, 'skills'), path.dirname(file)];
    if (!directories.every(isPlainDirectoryOrMissing)) continue;
    if (fs.existsSync(file)) {
      if (!fs.lstatSync(file).isFile()) continue;
      const previous = fs.readFileSync(file, 'utf8');
      if (previous === content || !previous.includes(MANAGED_SKILL_MARKER)) continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode: 0o600 });
  }
}

/**
 * The paths to remove when a Session skill folder holds exactly Pane's current
 * /wrap-up copy (file first, then its folders), or undefined when it holds
 * anything else.
 */
function managedSkillFolderEntries(folder: string): string[] | undefined {
  const expected = managedWrapUpSkill();
  const entries: string[] = [];
  let directory = folder;
  for (const name of WRAP_UP_SKILL_PATH) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
    const children = fs.readdirSync(directory);
    if (children.length !== 1 || children[0] !== name) return undefined;
    entries.unshift(directory);
    directory = path.join(directory, name);
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isFile() || expected === undefined || fs.readFileSync(directory, 'utf8') !== expected) return undefined;
  return [directory, ...entries];
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
    sessionTidyRules(sessionId, record),
    '## Session behavior profile',
    profile,
    `## Plans and documents
When you write a plan, report, or other document for the user, write it as one self-contained HTML file (inline CSS, SVG, and images) in this Session folder, for example plans/<topic>.html, and update it in place. Link it from the Session's status document (see Keep the Session tidy) instead of opening a tab for it. Open it beside the user only when they need to look at it now, with runpane panels open --url <file-url> --source agent --yes --json; it opens as a live browser in split view beside this conversation. Use --file <path> to open its editable source instead. Rerunning the command for the same target reuses its tab. The Session's status page is the exception: from the first time you dispatch work to a Pane, render it to session/index.html in this Session folder with the orchestrate-sessions skill's renderer, never by hand, and again at each change its references/status-board.md lists. The Overview tab shows it, so do not open it with panels open. Its links to pane://open?pane=<pane-id>&panel=<panel-id> open that tab and show its waiting question in Approvals.
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
1 feature = 1 worktree = 1 branch = 1 Pane; reviews, audits, fixes and QA for it are tabs in that Pane. First find the work's Pane with runpane panes list --json (match the PR's head branch against each worktree's current branch), and add a tab there when it exists. Create a Pane with runpane panes create only when the branch has no Pane yet (each new Pane creates a worktree), and run every later agent for it as a new tab in that Pane with runpane panels create --pane <id>, never a new Pane. Panes you create or adopt here are associated with this Session automatically; confirm with runpane sessions overview --session ${sessionId} --json, and use runpane sessions associate for existing Panes.
Never substitute plain git worktrees or built-in or background subagents for work delegated to a Pane. If runpane cannot reach Pane, stop and tell the user what failed.
Read ${guide} before coordinating Panes for the first time in a conversation. Follow its pane-orchestration guide for delivery, completion waits, and recovery.
## Orchestrator mode
You are in orchestrator mode: this Session's work moves through you. Only you ask the person: approvals come from you, not from the agents in this Session's Panes, who talk to you through needs_you or runpane report --state blocked --question. Answer them yourself when the person's request, the plan or an earlier decision settles it, and say which; ask the person only about the rest. Keep things moving: keep a running list of what this Session has to do, and read it again when you start, resume or wake. When the person asks about one thing while other work is open, answer it, then remind them what else is open and offer the next step. At the end of a turn, either have an approval waiting for the person in Approvals that moves the work on, or be done and say so; a turn that ends while your workers run, with your watch armed, is fine. Ask through Approvals, always with context: why it needs them and what each option means, the options with the one you recommend first, and the related files, PRs and pages as --links.
## What waits on the person (while Approvals is on)
Keep every item that waits on the person (a worker's needs_you or blocked question, a plan or design approval, a PR ready to merge, a next step only they can take) posted to Pane's Approvals, exactly once. Workers in this Session don't post; they report blocked to you. Post each item when it appears with runpane notify ... --json as a background command (in Claude Code, Bash with run_in_background), not the MCP notify tool or AskUserQuestion, so you stay free to talk; title it with its Q-n and pass the worker's files and PR as --links. Then acknowledge the worker's inbox item with runpane inbox ack <id>. When the call returns, send the answer only to the asking worker. Stop the background call of an item that went stale; that expires its card. When you start, resume or wake, reconcile against the status files, your ledger and runpane inbox: post what is missing and stop what is stale. Pane keeps no approvals across a restart, so after one, post each item that still waits again, exactly once. If notify returns unavailable because Approvals is off, ask in this tab as before.${record?.runtime === 'wsl' ? `\n${wslRouting(record)}` : ''}`;
}

/** Its own section, apart from delegationRules, so neither has to edit the other. */
function sessionTidyRules(sessionId: string, record?: OrchestrationSessionRecord): string {
  const wrapUp = sessionRuntimePath(path.join(sessionWorkspacePath(sessionId), '.claude', ...WRAP_UP_SKILL_PATH), record);
  return keepSessionTidySection(sessionId, wrapUp);
}

function wslRouting(record: OrchestrationSessionRecord): string {
  const appDirectory = sessionRuntimePath(getAppDirectory(), record);
  return `## WSL RunPane Routing
This Session runs in ${record.wslDistribution}. This file overrides the shared Pane Chat runtime context for this Session.
Pane runs on Windows. Linux processes cannot open its named pipe. The Session's runpane on PATH (also $PANE_RUNPANE_BIN) automatically invokes the bundled Windows CLI through powershell.exe from Windows TEMP.
Run runpane doctor --json --pane-dir "${appDirectory}" before using Pane. Pass --pane-dir "${appDirectory}" on every call. The bridge translates file arguments to Windows paths and always targets this instance. Use this bridge, not a Linux npm/npx runpane installation.
Session folder: ${sessionRuntimePath(sessionWorkspacePath(record.id), record)}
Windows CLI output contains Windows paths; translate them with wslpath -u before reading files in Linux. If interop or doctor fails, report the error and stop Pane actions.
Bundled Node scripts, such as the Session status page renderer, run with node; when this distro has none, run them with "${appDirectory}/bin/pane-node" (same arguments), which starts Pane's Windows runtime and converts path arguments.`;
}

/** Read-only check: never fold a workspace containing user edits or artifacts. */
export function isPristineSessionWorkspace(record: OrchestrationSessionRecord): boolean {
  const cwd = sessionWorkspacePath(record.id);
  if (!fs.existsSync(cwd)) return true;
  if (!fs.lstatSync(cwd).isDirectory() || fs.lstatSync(cwd).isSymbolicLink()) return false;
  const expectedAgents = `${START}\n${sessionInstructions(record.id, record.profile ?? DEFAULT_SESSION_PROFILE, record)}\n${END}`;
  return fs.readdirSync(cwd).every(name => {
    const file = path.join(cwd, name);
    if (isSessionSkillFolder(name)) return managedSkillFolderEntries(file) !== undefined;
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
  const skillEntries: string[] = [];
  let runtimeDirectory: string | undefined;
  for (const name of names) {
    const file = path.join(cwd, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return false;
    if (isSessionSkillFolder(name)) {
      const entries = managedSkillFolderEntries(file);
      if (!entries) return false;
      skillEntries.push(...entries);
      continue;
    }
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
  for (const entry of skillEntries) {
    if (fs.lstatSync(entry).isDirectory()) fs.rmdirSync(entry);
    else fs.unlinkSync(entry);
  }
  if (runtimeDirectory) fs.rmdirSync(runtimeDirectory);
  fs.rmdirSync(cwd);
  return true;
}
