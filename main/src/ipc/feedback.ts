import { execFile } from 'child_process';
import type { IpcMain } from 'electron';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { release, tmpdir } from 'os';
import { join } from 'path';
import type {
  FeedbackType,
  SubmitFeedbackFailure,
  SubmitFeedbackRequest,
  SubmitFeedbackSuccess,
} from '../../../shared/types/feedback';
import { getShellPath } from '../utils/shellPath';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const PANE_REPO = 'greenfield-inc/Pane';
const LEGACY_PANE_REPOS = ['dcouple/Pane', 'Dcouple-Inc/Pane'] as const;
const GITHUB_HOST = 'github.com';
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 65_536;

const LABELS = {
  bug: 'bug',
  feature: 'enhancement',
  general: 'question',
} satisfies Record<FeedbackType, string>;

const feedbackRequestSchema = boundary.object({
  type: boundary.enumeration('bug', 'feature', 'general'),
  title: boundary.string,
  body: boundary.string,
  includeAppDetails: boundary.boolean,
  appDetails: boundary.optional(boundary.object({
    version: boundary.string,
    gitCommit: boundary.string,
  })),
});

interface CommandResult {
  stdout: string;
  stderr: string;
}

export type FeedbackCommandRunner = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export interface FeedbackRuntime {
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  electronVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  osVersion: string;
  isPackaged: boolean;
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function validateRequest(value: PaneCommandValue): SubmitFeedbackRequest {
  const request = decodeBoundary(value, feedbackRequestSchema);
  if (request.title.length > MAX_TITLE_LENGTH) {
    throw new Error(`The title must be ${MAX_TITLE_LENGTH} characters or fewer.`);
  }
  if (!request.body.trim()) {
    throw new Error('Feedback text is required.');
  }
  if (request.body.length > MAX_BODY_LENGTH) {
    throw new Error('Feedback text is too long.');
  }
  return request;
}

function defaultTitle(request: SubmitFeedbackRequest): string {
  const explicitTitle = request.title.trim();
  if (explicitTitle) return explicitTitle;
  const firstLine = request.body.trim().split(/\r?\n/, 1)[0]?.trim() || 'Feedback from Pane';
  return firstLine.slice(0, MAX_TITLE_LENGTH);
}

function buildFeedbackBody(
  request: SubmitFeedbackRequest,
  runtime: FeedbackRuntime,
): string {
  const userBody = request.body.trim();
  if (!request.includeAppDetails) return userBody;

  const version = request.appDetails?.version || runtime.appVersion;
  const commit = request.appDetails?.gitCommit || 'unknown';
  return [
    userBody,
    '',
    '## App details',
    '',
    `- Version: ${version}`,
    `- Commit: ${commit}`,
    `- Platform: ${runtime.platform}`,
    `- OS version: ${runtime.osVersion}`,
    `- Architecture: ${runtime.arch}`,
    `- Electron: ${runtime.electronVersion}`,
    `- Chromium: ${runtime.chromiumVersion}`,
    `- Node.js: ${runtime.nodeVersion}`,
    `- App mode: ${runtime.isPackaged ? 'packaged' : 'development'}`,
    '',
    'Filed from Pane in-app feedback',
  ].join('\n');
}

export function buildFeedbackFallbackUrl(
  title: string,
  body: string,
  label: string,
): string {
  const params = new URLSearchParams({ title, body, labels: label });
  return `https://github.com/${PANE_REPO}/issues/new?${params.toString()}`;
}

function commandErrorText(error: Error): string {
  let stderr = '';
  try {
    stderr = decodeBoundary(error, boundary.object({
      stderr: boundary.optional(boundary.string),
    })).stderr ?? '';
  } catch {
    // Some command errors have no stderr property.
  }
  return `${error.message}\n${stderr ?? ''}`.trim();
}

function friendlyCommandError(error: Error, stage: 'auth' | 'create'): string {
  let code: string | number | undefined;
  try {
    code = decodeBoundary(error, boundary.object({
      code: boundary.optional(boundary.union(boundary.string, boundary.number)),
    })).code;
  } catch {
    // Some command errors have no process code.
  }
  if (code === 'ENOENT') {
    return 'GitHub CLI (gh) is not installed or is not available in Pane\'s PATH.';
  }
  const details = commandErrorText(error);
  if (stage === 'auth') {
    return 'GitHub CLI is not authenticated. Run “gh auth login” and try again.';
  }
  if (/scope|permission|resource not accessible|forbidden/i.test(details)) {
    return `GitHub CLI does not have permission to create issues in ${PANE_REPO}.`;
  }
  return details || 'GitHub CLI could not create the issue.';
}

function isLabelError(error: Error): boolean {
  return /label|could not add/i.test(commandErrorText(error));
}

function issueCreateArgs(title: string, bodyPath: string, labels: readonly string[]): string[] {
  const args = ['issue', 'create', '--repo', PANE_REPO, '--title', title, '--body-file', bodyPath];
  for (const label of labels) args.push('--label', label);
  return args;
}

function issueUrlFromOutput(stdout: string): string {
  const allowedRepositories = [PANE_REPO, ...LEGACY_PANE_REPOS]
    .map(repository => repository.replace('/', '\\/'))
    .join('|');
  const urlPattern = new RegExp(`^https:\\/\\/github\\.com\\/(?:${allowedRepositories})\\/issues\\/\\d+$`, 'i');
  const url = stdout.trim().split(/\s+/).find(value => urlPattern.test(value));
  if (!url) throw new Error('GitHub CLI created the issue but did not return its URL.');
  return url;
}

export async function submitFeedbackIssue(
  rawRequest: PaneCommandValue,
  runtime: FeedbackRuntime,
  commandRunner: FeedbackCommandRunner = runCommand,
): Promise<{ success: true; data: SubmitFeedbackSuccess } | { success: false; error: string; data: SubmitFeedbackFailure }> {
  let request: SubmitFeedbackRequest;
  try {
    request = validateRequest(rawRequest);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid feedback request.';
    return {
      success: false,
      error: message,
      data: { fallbackUrl: `https://github.com/${PANE_REPO}/issues/new` },
    };
  }

  const title = defaultTitle(request);
  const body = buildFeedbackBody(request, runtime);
  const primaryLabel = LABELS[request.type];
  const fallbackUrl = buildFeedbackFallbackUrl(title, body, primaryLabel);
  const env = { ...process.env, PATH: getShellPath() };

  try {
    await commandRunner('gh', ['auth', 'status', '--hostname', GITHUB_HOST], { env });
  } catch (error) {
    const cause = error instanceof Error ? error : new Error('GitHub authentication check failed.');
    return { success: false, error: friendlyCommandError(cause, 'auth'), data: { fallbackUrl } };
  }

  let includeFeedbackLabel = false;
  try {
    await commandRunner('gh', ['label', 'view', 'feedback', '--repo', PANE_REPO], { env });
    includeFeedbackLabel = true;
  } catch {
    // The optional feedback label is absent or unavailable; the primary label still applies.
  }

  let tempDirectory: string | undefined;
  try {
    tempDirectory = await mkdtemp(join(tmpdir(), 'pane-feedback-'));
    const bodyPath = join(tempDirectory, 'issue-body.md');
    await writeFile(bodyPath, body, { encoding: 'utf8', mode: 0o600 });
    const labels = includeFeedbackLabel ? [primaryLabel, 'feedback'] : [primaryLabel];
    let result: CommandResult;
    try {
      result = await commandRunner('gh', issueCreateArgs(title, bodyPath, labels), { env });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error('GitHub issue creation failed.');
      if (!isLabelError(cause)) throw cause;
      result = await commandRunner('gh', issueCreateArgs(title, bodyPath, []), { env });
    }
    return { success: true, data: { issueUrl: issueUrlFromOutput(result.stdout) } };
  } catch (error) {
    const cause = error instanceof Error ? error : new Error('GitHub issue creation failed.');
    return { success: false, error: friendlyCommandError(cause, 'create'), data: { fallbackUrl } };
  } finally {
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function registerFeedbackHandlers(
  ipcMain: IpcMain,
  runtime: { app: { getVersion(): string; isPackaged: boolean } },
): void {
  ipcMain.handle('feedback:submit', (_event, request: PaneCommandValue) => submitFeedbackIssue(request, {
    appVersion: runtime.app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron || 'unknown',
    chromiumVersion: process.versions.chrome || 'unknown',
    nodeVersion: process.versions.node,
    osVersion: release(),
    isPackaged: runtime.app.isPackaged,
  }));
}
