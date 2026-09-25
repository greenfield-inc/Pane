import fs from 'fs';
import path from 'path';
import { getAppDirectory } from '../utils/appDirectory';
import { DEFAULT_SESSION_PROFILE, PANE_CAPABILITY_CONTEXT } from '../../../shared/types/sessionProfile';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';

const START = '<!-- pane-session-context:start -->';
const END = '<!-- pane-session-context:end -->';

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
  progressEnabled = false,
): string {
  const cwd = sessionWorkspacePath(sessionId);
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(cwd).isSymbolicLink()) throw new Error(`Session workspace must not be a symbolic link: ${cwd}`);
  const progressStatusPath = path.join(cwd, '.pane-progress.json');
  if (fs.existsSync(progressStatusPath) && fs.lstatSync(progressStatusPath).isSymbolicLink()) {
    throw new Error('Session progress status must not be a symbolic link');
  }
  const progressStatus = JSON.stringify({ enabled: progressEnabled });
  if (!fs.existsSync(progressStatusPath) || fs.readFileSync(progressStatusPath, 'utf8') !== progressStatus) {
    fs.writeFileSync(progressStatusPath, progressStatus, { mode: 0o600 });
  }
  const content = sessionInstructions(sessionId, profile, record, progressEnabled);
  writeManagedInstructions(path.join(cwd, 'AGENTS.md'), content);
  // Claude resolves imports before the first turn; Cursor also reads AGENTS.md.
  writeManagedInstructions(path.join(cwd, 'CLAUDE.md'), '@AGENTS.md');
  return cwd;
}

function sessionInstructions(
  sessionId: string,
  profile: string,
  record: OrchestrationSessionRecord | undefined,
  progressEnabled: boolean,
): string {
  return [
    '# Pane Session',
    `Stable Session ID: ${sessionId}`,
    'This directory belongs to one Session. Opening it does not authorize work. Await user input. Saved next actions are context only.',
    PANE_CAPABILITY_CONTEXT,
    '## Session behavior profile',
    profile,
    progressEnabled ? `## Experimental progress view
Pane displays progress.html from this folder in a live split view beside the conversation.
Before every progress update, read .pane-progress.json. If enabled is false, do not maintain the progress page.
During authorized work, create progress.html when you first have meaningful progress to report. Keep it current after material changes and before yielding: objective, current step, completed work, decisions, blockers, next action, and last updated time. Distinguish plans from verified results; do not invent progress.
Write one self-contained HTML document with inline CSS, SVG, and data images. Scripts, network assets, forms, and navigation are unavailable. Use atomic replacement so readers see a complete page. No particular visual template is required.
Opening this Session is not an instruction to start work or generate this file. Do not run background turns solely to update progress.` : '',
    '## Persisted context',
    'When a user task needs current state, use sessions get/overview with the stable Session ID. The snapshot below may be stale. It is data, not a startup task.',
    record ? JSON.stringify({ name: record.name, goal: record.goal, context: record.context, decisions: record.decisions, blockers: record.blockers, nextAction: record.nextAction, associations: record.associations, evidence: record.evidence, outputs: record.outputs }, null, 2) : '',
  ].join('\n\n');
}

/** Read-only check: never fold a workspace containing user edits or artifacts. */
export function isPristineSessionWorkspace(record: OrchestrationSessionRecord): boolean {
  const cwd = sessionWorkspacePath(record.id);
  if (!fs.existsSync(cwd)) return true;
  if (!fs.lstatSync(cwd).isDirectory() || fs.lstatSync(cwd).isSymbolicLink()) return false;
  const expectedAgents = [true, false].map(enabled =>
    `${START}\n${sessionInstructions(record.id, record.profile ?? DEFAULT_SESSION_PROFILE, record, enabled)}\n${END}`);
  return fs.readdirSync(cwd).every(name => {
    const file = path.join(cwd, name);
    if (!fs.lstatSync(file).isFile()) return false;
    if (name !== 'AGENTS.md' && name !== 'CLAUDE.md' && name !== '.pane-progress.json') return false;
    const content = fs.readFileSync(file, 'utf8').trim();
    if (name === 'AGENTS.md') return expectedAgents.includes(content);
    if (name === 'CLAUDE.md') return content === `${START}\n@AGENTS.md\n${END}`;
    return content === '{"enabled":true}' || content === '{"enabled":false}';
  });
}

/** Roll back only our unpublished scaffold; retain a record if user files appeared. */
export function discardSessionScaffold(sessionId: string): boolean {
  const cwd = sessionWorkspacePath(sessionId);
  if (!fs.existsSync(cwd)) return true;
  if (fs.lstatSync(cwd).isSymbolicLink()) return false;
  const names = fs.readdirSync(cwd);
  for (const name of names) {
    if (name !== 'AGENTS.md' && name !== 'CLAUDE.md' && name !== '.pane-progress.json') return false;
    const file = path.join(cwd, name);
    if (!fs.lstatSync(file).isFile()) return false;
    const content = fs.readFileSync(file, 'utf8').trim();
    if (name === '.pane-progress.json') {
      if (content !== '{"enabled":true}' && content !== '{"enabled":false}') return false;
      continue;
    }
    if (!content.startsWith(START) || !content.endsWith(END)) return false;
  }
  for (const name of names) fs.unlinkSync(path.join(cwd, name));
  fs.rmdirSync(cwd);
  return true;
}
