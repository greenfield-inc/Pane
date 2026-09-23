import { readFile } from 'fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { SubmitFeedbackRequest } from '../../../shared/types/feedback';
import {
  buildFeedbackFallbackUrl,
  submitFeedbackIssue,
  type FeedbackCommandRunner,
} from './feedback';

const runtime = {
  appVersion: '2.4.48',
  platform: 'darwin' as const,
  arch: 'arm64',
  electronVersion: '41.0.0',
  chromiumVersion: '142.0.0.0',
  nodeVersion: '24.0.0',
  osVersion: '25.6.0',
  isPackaged: true,
};

const request: SubmitFeedbackRequest = {
  type: 'bug',
  title: 'Terminal freezes on paste',
  body: 'Pasting **Markdown** freezes the terminal.\n\n`do not shell interpolate me`',
  includeAppDetails: true,
  appDetails: {
    version: '2.4.48',
    gitCommit: 'e3c4fa7 (modified)',
  },
};

function commandError(message: string, options?: { code?: string; stderr?: string }): Error {
  return Object.assign(new Error(message), options);
}

describe('feedback IPC', () => {
  it('creates an issue with the body in a temporary file, never in command arguments', async () => {
    let bodyFromFile = '';
    const runner = vi.fn<FeedbackCommandRunner>(async (_command, args) => {
      if (args[0] === 'issue') {
        const bodyPath = args[args.indexOf('--body-file') + 1];
        bodyFromFile = await readFile(bodyPath, 'utf8');
        return { stdout: 'https://github.com/greenfield-inc/Pane/issues/999\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await submitFeedbackIssue(request, runtime, runner);

    expect(result).toEqual({
      success: true,
      data: { issueUrl: 'https://github.com/greenfield-inc/Pane/issues/999' },
    });
    expect(bodyFromFile).toContain(request.body);
    expect(bodyFromFile).toContain('## App details');
    expect(bodyFromFile).toContain('- Commit: e3c4fa7 (modified)');
    expect(bodyFromFile).toContain('- OS version: 25.6.0');
    expect(bodyFromFile).toContain('- Chromium: 142.0.0.0');
    expect(bodyFromFile).toContain('- Node.js: 24.0.0');
    expect(bodyFromFile).toContain('- App mode: packaged');
    expect(bodyFromFile).toContain('Filed from Pane in-app feedback');
    const allArgs = runner.mock.calls.flatMap(call => call[1]);
    expect(allArgs).not.toContain(request.body);
    expect(runner.mock.calls.find(call => call[1][0] === 'issue')?.[1]).toContain('--body-file');
  });

  it('surfaces a clear gh-missing error and preserves text in the browser fallback', async () => {
    const runner = vi.fn<FeedbackCommandRunner>().mockRejectedValue(commandError('spawn gh ENOENT', { code: 'ENOENT' }));

    const result = await submitFeedbackIssue(request, runtime, runner);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('not installed');
    const fallback = new URL(result.data.fallbackUrl);
    expect(fallback.searchParams.get('title')).toBe(request.title);
    expect(fallback.searchParams.get('body')).toContain(request.body);
    expect(fallback.searchParams.get('labels')).toBe('bug');
  });

  it('surfaces a clear unauthenticated error', async () => {
    const runner = vi.fn<FeedbackCommandRunner>().mockRejectedValue(commandError('not logged in'));

    const result = await submitFeedbackIssue(request, runtime, runner);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('gh auth login');
  });

  it('omits the optional feedback label when it does not exist', async () => {
    const runner = vi.fn<FeedbackCommandRunner>(async (_command, args) => {
      if (args[0] === 'label') throw commandError('label not found');
      if (args[0] === 'issue') {
        expect(args).toContain('bug');
        expect(args).not.toContain('feedback');
        return { stdout: 'https://github.com/greenfield-inc/Pane/issues/1000', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(submitFeedbackIssue(request, runtime, runner)).resolves.toMatchObject({ success: true });
  });

  it('retries issue creation without labels when GitHub rejects a label', async () => {
    let createAttempts = 0;
    const runner = vi.fn<FeedbackCommandRunner>(async (_command, args) => {
      if (args[0] !== 'issue') return { stdout: '', stderr: '' };
      createAttempts += 1;
      if (createAttempts === 1) {
        expect(args).toContain('feedback');
        throw commandError('could not add label: feedback', { stderr: 'label not found' });
      }
      expect(args).not.toContain('--label');
      return { stdout: 'https://github.com/greenfield-inc/Pane/issues/1001', stderr: '' };
    });

    const result = await submitFeedbackIssue(request, runtime, runner);

    expect(result).toMatchObject({ success: true });
    expect(createAttempts).toBe(2);
  });

  it('builds a stable prefilled GitHub URL', () => {
    const url = new URL(buildFeedbackFallbackUrl('A title', 'A body', 'enhancement'));
    expect(url.origin + url.pathname).toBe('https://github.com/greenfield-inc/Pane/issues/new');
    expect(url.searchParams.get('title')).toBe('A title');
    expect(url.searchParams.get('body')).toBe('A body');
    expect(url.searchParams.get('labels')).toBe('enhancement');
  });

  it.each([
    'https://github.com/dcouple/Pane/issues/1002',
    'https://github.com/Dcouple-Inc/Pane/issues/1003',
  ])('accepts intentional legacy issue URLs returned by gh: %s', async (issueUrl) => {
    const runner = vi.fn<FeedbackCommandRunner>(async (_command, args) => {
      if (args[0] === 'issue') return { stdout: `${issueUrl}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    await expect(submitFeedbackIssue(request, runtime, runner)).resolves.toEqual({
      success: true,
      data: { issueUrl },
    });
  });

  it.each([
    'https://evil.example/greenfield-inc/Pane/issues/1004',
    'https://github.com/greenfield-inc/Other/issues/1005',
    'https://github.com/greenfield-inc/Pane/issues/1006?redirect=https://evil.example',
  ])('rejects unsafe issue URLs returned by gh: %s', async (issueUrl) => {
    const runner = vi.fn<FeedbackCommandRunner>(async (_command, args) => {
      if (args[0] === 'issue') return { stdout: `${issueUrl}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await submitFeedbackIssue(request, runtime, runner);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('did not return its URL');
      expect(new URL(result.data.fallbackUrl).hostname).toBe('github.com');
    }
  });
});
