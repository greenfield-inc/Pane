import { describe, expect, it, vi } from 'vitest';
import type { SubmitFeedbackRequest } from '../../../shared/types/feedback';
import {
  canSubmitFeedback,
  createInitialFeedbackDialogState,
  executeFeedbackSubmission,
  feedbackDialogReducer,
  openFeedbackUrl,
} from './feedbackDialogState';

const request: SubmitFeedbackRequest = {
  type: 'bug',
  title: 'Pasted title',
  body: 'Pasted **Markdown** body',
  includeAppDetails: true,
  appDetails: { version: '2.4.48', gitCommit: 'e3c4fa7 (modified)' },
};

describe('FeedbackDialog state', () => {
  it('keeps submit disabled until feedback is present and while submitting', () => {
    const empty = createInitialFeedbackDialogState();
    expect(canSubmitFeedback(empty)).toBe(false);

    const filled = feedbackDialogReducer(empty, { type: 'set-body', value: request.body });
    expect(canSubmitFeedback(filled)).toBe(true);
    expect(canSubmitFeedback(feedbackDialogReducer(filled, { type: 'submit-start' }))).toBe(false);
  });

  it('moves to success after the mocked renderer API returns an issue URL', async () => {
    const submit = vi.fn().mockResolvedValue({
      success: true,
      data: { issueUrl: 'https://github.com/greenfield-inc/Pane/issues/999' },
    });

    const action = await executeFeedbackSubmission(request, submit);

    expect(submit).toHaveBeenCalledWith(request);
    expect(action).toEqual({
      type: 'submit-success',
      issueUrl: 'https://github.com/greenfield-inc/Pane/issues/999',
    });
  });

  it('preserves the form and exposes the browser fallback after failure', async () => {
    const fallbackUrl = 'https://github.com/greenfield-inc/Pane/issues/new?title=Pasted+title';
    const action = await executeFeedbackSubmission(request, vi.fn().mockResolvedValue({
      success: false,
      error: 'GitHub CLI is not authenticated.',
      data: { fallbackUrl },
    }));
    const filled = {
      ...createInitialFeedbackDialogState(),
      title: request.title,
      body: request.body,
    };
    expect(action).toBeDefined();
    if (!action) return;
    const failed = feedbackDialogReducer(filled, action);

    expect(failed.title).toBe(request.title);
    expect(failed.body).toBe(request.body);
    expect(failed.status).toBe('error');
    expect(failed.fallbackUrl).toBe(fallbackUrl);
  });

  it('ignores a submission response after the dialog closes', async () => {
    const abortController = new AbortController();
    let resolveSubmission: ((value: {
      success: true;
      data: { issueUrl: string };
    }) => void) | undefined;
    const submit = vi.fn().mockReturnValue(new Promise(resolve => {
      resolveSubmission = resolve;
    }));
    const actionPromise = executeFeedbackSubmission(request, submit, abortController.signal);

    abortController.abort();
    resolveSubmission?.({
      success: true,
      data: { issueUrl: 'https://github.com/greenfield-inc/Pane/issues/999' },
    });

    await expect(actionPromise).resolves.toBeUndefined();
  });

  it('surfaces resolved failures from the system browser IPC', async () => {
    await expect(openFeedbackUrl(
      'https://github.com/greenfield-inc/Pane/issues/new',
      vi.fn().mockResolvedValue({ success: false, error: 'Browser launch failed' }),
    )).resolves.toBe('Browser launch failed');
  });
});
