import { useEffect, useReducer, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, MessageSquareText } from 'lucide-react';
import type {
  FeedbackAppDetails,
} from '../../../shared/types/feedback';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';
import { Button } from './ui/Button';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import {
  canSubmitFeedback,
  createInitialFeedbackDialogState,
  executeFeedbackSubmission,
  feedbackDialogReducer,
  openFeedbackUrl,
} from './feedbackDialogState';

interface FeedbackDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function FeedbackDialog({ isOpen, onClose }: FeedbackDialogProps) {
  const [state, dispatch] = useReducer(feedbackDialogReducer, undefined, createInitialFeedbackDialogState);
  const appDetailsRef = useRef<FeedbackAppDetails | undefined>(undefined);
  const submissionAbortRef = useRef<AbortController | undefined>(undefined);
  const [isLoadingAppDetails, setIsLoadingAppDetails] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const submissionAbort = new AbortController();
    submissionAbortRef.current = submissionAbort;
    dispatch({ type: 'reset' });
    appDetailsRef.current = undefined;
    setIsLoadingAppDetails(true);
    void window.electronAPI.getVersionInfo().then(response => {
      if (cancelled || !response.success || !response.data) return;
      const data = decodeOptionalBoundary(response.data, boundary.object({
        current: boundary.optional(boundary.string),
        gitCommit: boundary.optional(boundary.string),
      }));
      if (!data) return;
      appDetailsRef.current = {
        version: data.current ?? '',
        gitCommit: data.gitCommit ?? '',
      };
    }).catch(() => {
      if (!cancelled) appDetailsRef.current = undefined;
    }).finally(() => {
      if (!cancelled) setIsLoadingAppDetails(false);
    });
    return () => {
      cancelled = true;
      submissionAbort.abort();
      if (submissionAbortRef.current === submissionAbort) submissionAbortRef.current = undefined;
    };
  }, [isOpen]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmitFeedback(state) || (state.includeAppDetails && isLoadingAppDetails)) return;
    dispatch({ type: 'submit-start' });
    const action = await executeFeedbackSubmission({
      type: state.type,
      title: state.title,
      body: state.body,
      includeAppDetails: state.includeAppDetails,
      appDetails: appDetailsRef.current,
    }, window.electronAPI.feedback.submit, submissionAbortRef.current?.signal);
    if (action) dispatch(action);
  };

  const openExternal = (url: string) => {
    void openFeedbackUrl(url, window.electronAPI.openExternal).then(error => {
      if (!error) return;
      dispatch({
        type: 'submit-error',
        error,
        fallbackUrl: state.fallbackUrl,
      });
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      ariaLabel="Send feedback"
      size="md"
      initialFocusRef={bodyRef}
      closeOnOverlayClick={false}
      showCloseButton={false}
    >
      <ModalHeader
        title="Send feedback"
        icon={<MessageSquareText className="h-5 w-5" />}
        description={<span className="text-text-primary">Create a public issue in greenfield-inc/Pane.</span>}
        onClose={onClose}
      />

      {state.status === 'success' && state.issueUrl ? (
        <>
          <ModalBody className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-status-success/30 bg-status-success/10 p-4">
              <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-status-success" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-medium text-text-primary">Feedback submitted</p>
                <button
                  type="button"
                  onClick={() => openExternal(state.issueUrl!)}
                  className="mt-1 inline-flex max-w-full items-center gap-1 text-sm text-interactive hover:underline"
                >
                  <span className="truncate">{state.issueUrl}</span>
                  <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                </button>
              </div>
            </div>
            <p className="text-sm text-text-secondary">
              Screenshots help. Open the issue and paste images into a comment — GitHub uploads them for you.
            </p>
          </ModalBody>
          <ModalFooter>
            <Button type="button" variant="secondary" className="text-text-primary" onClick={() => dispatch({ type: 'reset' })}>
              Send another
            </Button>
            <Button type="button" onClick={onClose}>Done</Button>
          </ModalFooter>
        </>
      ) : (
        <form onSubmit={submit}>
          <ModalBody className="space-y-4">
            <p className="rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-text-primary">
              This issue will be PUBLIC on GitHub and posted using your authenticated GitHub account.
            </p>

            <label className="block space-y-1.5 text-sm text-text-primary">
              <span>Type</span>
              <select
                value={state.type}
                onChange={event => dispatch({
                  type: 'set-type',
                  value: decodeBoundary(event.target.value, boundary.enumeration('bug', 'feature', 'general')),
                })}
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-text-primary outline-none focus:border-interactive"
              >
                <option value="bug">Bug</option>
                <option value="feature">Feature request</option>
                <option value="general">General feedback</option>
              </select>
            </label>

            <label className="block space-y-1.5 text-sm text-text-primary">
              <span>Title <span>(optional)</span></span>
              <input
                type="text"
                maxLength={120}
                value={state.title}
                onChange={event => dispatch({ type: 'set-title', value: event.target.value })}
                placeholder="Short summary"
                className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-text-primary outline-none placeholder:text-text-tertiary focus:border-interactive"
              />
            </label>

            <label className="block space-y-1.5 text-sm text-text-primary">
              <span>Feedback</span>
              <textarea
                ref={bodyRef}
                required
                rows={8}
                maxLength={65_536}
                value={state.body}
                onChange={event => dispatch({ type: 'set-body', value: event.target.value })}
                placeholder="Describe the bug, idea, or feedback. Plain text and Markdown are welcome."
                className="w-full resize-y rounded-md border border-border-primary bg-surface-secondary px-3 py-2 font-mono text-sm text-text-primary outline-none placeholder:font-sans placeholder:text-text-tertiary focus:border-interactive"
              />
            </label>

            <label className="flex cursor-pointer items-start gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={state.includeAppDetails}
                onChange={event => dispatch({ type: 'set-include-details', value: event.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-border-primary accent-interactive"
              />
              <span>Include app details <span>(version, commit, OS, architecture, and runtime versions)</span></span>
            </label>

            {state.status === 'error' && (
              <div role="alert" className="rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-text-primary">
                <p>{state.error}</p>
                {state.fallbackUrl && (
                  <button
                    type="button"
                    onClick={() => openExternal(state.fallbackUrl!)}
                    className="mt-2 inline-flex items-center gap-1 font-medium text-interactive hover:underline"
                  >
                    Open pre-filled issue in browser
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button type="button" variant="secondary" className="text-text-primary" onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              disabled={!canSubmitFeedback(state) || (state.includeAppDetails && isLoadingAppDetails)}
              loading={state.status === 'submitting'}
              loadingText="Submitting…"
            >
              {state.status === 'submitting' ? 'Submitting…' : 'Submit feedback'}
            </Button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}
