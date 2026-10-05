import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, GitPullRequest, Loader2 } from 'lucide-react';
import { API } from '../../utils/api';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { Button } from '../ui/Button';
import { BranchCombobox } from './BranchCombobox';
import { PullRequestChanges } from './PullRequestChanges';
import type { PullRequestDraft } from '../../../../shared/types/pullRequest';

export interface CreatePullRequestDialogProps {
  sessionId: string;
  sessionName: string;
  isOpen: boolean;
  onClose: () => void;
  /** Called with the new pull request's URL once GitHub has it. */
  onCreated?: (url: string) => void;
}

/**
 * Open a pull request for a session's branch.
 *
 * The session already is a branch in a worktree, so the only real decisions are
 * the target repository — a fork has two, and picking your own by accident is a
 * silent mistake — and the text. Everything else is gathered by the main
 * process in one call and shown here as the starting point.
 */
export function CreatePullRequestDialog({
  sessionId,
  sessionName,
  isOpen,
  onClose,
  onCreated,
}: CreatePullRequestDialogProps) {
  const [draft, setDraft] = useState<PullRequestDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [targetRepo, setTargetRepo] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [baseBranches, setBaseBranches] = useState<string[]>([]);
  const [localBaseBranches, setLocalBaseBranches] = useState<string[]>([]);
  const [isDraftPr, setIsDraftPr] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    API.pullRequests.getDraft(sessionId)
      .then(response => {
        if (cancelled) return;
        if (!response.success || !response.data) {
          throw new Error(response.error || 'Could not prepare the pull request');
        }
        setDraft(response.data);
        setTitle(response.data.title || sessionName);
        setBody(response.data.body);
        setTargetRepo(response.data.defaultTarget);
        setBaseBranch(response.data.baseBranch);
        setBaseBranches(response.data.baseBranches);
        setLocalBaseBranches(response.data.localBaseBranches);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not prepare the pull request');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [isOpen, sessionId, sessionName]);

  /**
   * The base has to exist in the *target* repository, and a fork's branches are
   * not the upstream's — so the list is reloaded whenever the target changes.
   */
  const [loadingBranches, setLoadingBranches] = useState(false);
  useEffect(() => {
    if (!isOpen || !targetRepo || !draft) return;
    if (targetRepo === draft.defaultTarget && draft.baseBranches.length > 0) {
      setBaseBranches(draft.baseBranches);
      setLocalBaseBranches(draft.localBaseBranches);
      return;
    }

    let cancelled = false;
    setLoadingBranches(true);
    API.pullRequests.listBaseBranches(sessionId, targetRepo)
      .then(response => {
        if (cancelled || !response.success || !response.data) return;
        const { all, local } = response.data;
        setBaseBranches(all);
        setLocalBaseBranches(local);
        // Keep the current base when the new target also has it; otherwise fall
        // back to that repository's default.
        setBaseBranch(current => (all.includes(current)
          ? current
          : all.find(name => name === 'main' || name === 'master') ?? current));
      })
      .catch(() => { /* the field stays editable, so this is not fatal */ })
      .finally(() => { if (!cancelled) setLoadingBranches(false); });

    return () => { cancelled = true; };
  }, [isOpen, targetRepo, draft, sessionId]);

  const submit = useCallback(async () => {
    if (!draft) return;

    setSubmitting(true);
    setError(null);
    try {
      const response = await API.pullRequests.create({
        sessionId,
        title: title.trim(),
        body,
        baseBranch,
        targetRepo,
        draft: isDraftPr,
      });

      if (!response.success || !response.data) {
        throw new Error(response.error || 'Could not create the pull request');
      }

      onCreated?.(response.data.url);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the pull request');
    } finally {
      setSubmitting(false);
    }
  }, [draft, sessionId, title, body, baseBranch, targetRepo, isDraftPr, onCreated, onClose]);

  /**
   * A base has to exist in the *target*. Your own feature branches live in your
   * fork, so basing on one only works with the fork as the target — worth
   * saying here rather than letting GitHub reject the push.
   */
  const otherTarget = draft?.targets.find(target => target.nameWithOwner !== targetRepo)?.nameWithOwner;
  const baseIsUnknown = Boolean(
    baseBranch.trim() && baseBranches.length > 0 && !baseBranches.includes(baseBranch.trim())
  );

  const blocked = (draft?.blockers.length ?? 0) > 0;
  const canSubmit = Boolean(draft) && !blocked && !baseIsUnknown && !submitting
    && title.trim().length > 0 && targetRepo.length > 0 && baseBranch.trim().length > 0;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" ariaLabel="Create pull request" showCloseButton={false}>
      <ModalHeader
        title="Create pull request"
        icon={<GitPullRequest className="h-4 w-4" />}
        description={draft ? `${draft.branch} → ${targetRepo}:${baseBranch}` : sessionName}
        onClose={onClose}
      />

      <ModalBody className="space-y-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-text-tertiary">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Reading the branch…
          </div>
        ) : (
          <>
            {/*
              An existing pull request is the most useful thing to say: there is
              nothing to create, and the link is what the user actually wants.
            */}
            {draft?.existing && (
              <div className="flex items-start gap-2 rounded border border-interactive/40 bg-interactive/10 p-2 text-xs text-text-secondary">
                <ExternalLink className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-interactive" aria-hidden="true" />
                <span>
                  This branch already has a pull request:{' '}
                  <a
                    href={draft.existing.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-interactive underline"
                  >
                    #{draft.existing.number} {draft.existing.title}
                  </a>{' '}
                  ({draft.existing.state.toLowerCase()}). Pushing again updates it — creating a second one is not possible.
                </span>
              </div>
            )}

            {draft?.blockers.map(blocker => (
              <div
                key={blocker}
                className="flex items-start gap-2 rounded border border-status-warning/40 bg-status-warning/10 p-2 text-xs text-status-warning"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                <span>{blocker}</span>
              </div>
            ))}

            {draft?.hasUncommittedChanges && (
              <p className="rounded border border-border-secondary bg-surface-tertiary p-2 text-xs text-text-tertiary">
                This worktree has uncommitted changes. They stay behind — only what is committed goes into the
                pull request.
              </p>
            )}

            {/*
              Which branch is proposed, spelled out. "Base" is where the work
              goes *into*, and reading it as "the branch I built" is the easiest
              mistake to make in this dialog.
            */}
            {draft?.branch && (
              <p className="rounded border border-border-secondary bg-surface-tertiary px-2 py-1.5 text-xs text-text-tertiary">
                Sending <span className="font-mono text-text-secondary">{draft.branch}</span>
                {' '}— this session&rsquo;s branch, with the commits below —{' '}
                to <span className="font-mono text-text-secondary">{targetRepo}</span>, to be merged into{' '}
                <span className="font-mono text-text-secondary">{baseBranch || '…'}</span>.
              </p>
            )}

            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-text-muted">Title</span>
              <input
                value={title}
                onChange={event => setTitle(event.target.value)}
                className="mt-1 w-full rounded border border-border-secondary bg-surface-primary px-2 py-1 text-sm text-text-primary focus:border-interactive focus:outline-none"
              />
            </label>

            {/*
              One destination, spelled as one thing: "into repository" and "base
              branch" are two halves of a single address (`owner/repo:branch`),
              and naming them separately made them read as two decisions.
            */}
            <div className="rounded border border-border-secondary p-2">
              <span className="text-[11px] uppercase tracking-wider text-text-muted">Merge destination</span>
              <div className="mt-1 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[11px] text-text-muted">Repository</span>
                  <select
                    value={targetRepo}
                    onChange={event => setTargetRepo(event.target.value)}
                    className="mt-0.5 w-full rounded border border-border-secondary bg-surface-primary px-2 py-1 text-sm text-text-primary focus:border-interactive focus:outline-none"
                  >
                    {(draft?.targets ?? []).map(target => (
                      <option key={target.nameWithOwner} value={target.nameWithOwner}>
                        {target.nameWithOwner}{target.isParent ? ' (upstream)' : ''}
                      </option>
                    ))}
                  </select>
                </label>

                <div>
                  <label htmlFor="pane-pr-base-branch" className="block text-[11px] text-text-muted">
                    Branch in that repository
                  </label>
                  {/*
                    Editable as well as selectable: the list comes from the
                    target repository, and a branch pushed a minute ago may not
                    be in it yet.
                  */}
                  <div className="mt-0.5">
                    <BranchCombobox
                      id="pane-pr-base-branch"
                      value={baseBranch}
                      branches={baseBranches}
                      primaryBranches={localBaseBranches}
                      allLabel={targetRepo}
                      loading={loadingBranches}
                      onChange={setBaseBranch}
                    />
                  </div>
                </div>
              </div>
            </div>

            {baseIsUnknown && (
              <p className="rounded border border-status-warning/40 bg-status-warning/10 p-2 text-xs text-status-warning">
                <strong className="font-medium">{baseBranch}</strong> is not a branch in {targetRepo}
                {otherTarget ? `, so GitHub would reject it. Branches you pushed yourself live in ${otherTarget} — switch the target repository above to base on one of them.` : ', so GitHub would reject it.'}
              </p>
            )}

            <PullRequestChanges sessionId={sessionId} baseBranch={baseBranch} />

            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-text-muted">
                Description
                {draft && draft.commitCount > 0 && (
                  <span className="ml-2 normal-case tracking-normal text-text-muted">
                    from {draft.commitCount} {draft.commitCount === 1 ? 'commit' : 'commits'}
                    {draft.body.includes('##') ? ' and the repository template' : ''}
                  </span>
                )}
              </span>
              <textarea
                value={body}
                onChange={event => setBody(event.target.value)}
                rows={8}
                className="mt-1 w-full resize-y rounded border border-border-secondary bg-surface-primary px-2 py-1 font-mono text-xs text-text-primary focus:border-interactive focus:outline-none"
              />
            </label>

            <label className="flex items-center gap-2 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={isDraftPr}
                onChange={event => setIsDraftPr(event.target.checked)}
                className="h-3 w-3 accent-[color:var(--color-interactive,#4f8ef7)]"
              />
              Open as a draft
            </label>

            {error && (
              <p role="alert" className="rounded border border-status-error/30 bg-status-error/10 p-2 text-xs text-status-error">
                {error}
              </p>
            )}
          </>
        )}
      </ModalBody>

      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => { void submit(); }}
          disabled={!canSubmit}
          icon={submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitPullRequest className="h-4 w-4" />}
        >
          {submitting ? 'Pushing and opening…' : 'Create pull request'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
