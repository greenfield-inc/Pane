import { useEffect, useState } from 'react';
import { CloudUpload } from 'lucide-react';
import { Button } from '../ui/Button';
import { RemoteGroup } from './RemoteGroup';
import { CARD_ROW, errorMessage } from './CodelessRemoteSettings';
import { API } from '../../utils/api';
import type {
  RunpaneHostPushAllResult,
  RunpaneHostPushResult,
  RunpaneHostUnpushedItem,
} from '../../../../shared/types/runpaneOrchestration';

type Load =
  | { status: 'loading' }
  | { status: 'failed'; error: string }
  | { status: 'ready'; items: RunpaneHostUnpushedItem[] };

/**
 * "Work not on GitHub" for the machine Pane is using: each open Pane whose work is only on that
 * machine, and one action that pushes them all. It talks to the active host, so any machine page
 * that is about the active machine can show it.
 */
export function UnpushedWorkGroup() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [confirming, setConfirming] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushed, setPushed] = useState<RunpaneHostPushAllResult | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    API.host.unpushed().then(
      (result) => { if (current) setLoad({ status: 'ready', items: result.items }); },
      (cause: Error) => { if (current) setLoad({ status: 'failed', error: errorMessage(cause, 'Could not check this machine.') }); },
    );
    return () => { current = false; };
  }, []);

  const pushAll = async () => {
    setConfirming(false);
    setPushing(true);
    setPushError(null);
    try {
      setPushed(await API.host.pushAll());
    } catch (cause) {
      setPushError(errorMessage(cause, 'Could not push.'));
    } finally {
      setPushing(false);
    }
  };

  const items = load.status === 'ready' ? load.items : [];
  const canPush = items.length > 0 && !pushed;
  const footnote = pushed
    ? pushed.remaining === 0 ? 'Everything here is on GitHub now.' : `${pushed.remaining} ${pushed.remaining === 1 ? 'Pane still has' : 'Panes still have'} work only on this machine.`
    : canPush ? 'Push all commits loose files as "WIP" and never forces. A Pane on its base branch goes to pane/saved/<name>.' : undefined;

  return (
    <RemoteGroup
      title="Work not on GitHub"
      footnote={footnote}
      aside={canPush && !confirming ? (
        <Button type="button" variant="secondary" size="sm" icon={<CloudUpload className="h-4 w-4" />} loading={pushing} onClick={() => setConfirming(true)}>
          Push all
        </Button>
      ) : undefined}
    >
      {confirming && (
        <div className={`flex flex-wrap items-center justify-between gap-3 bg-surface-secondary ${CARD_ROW}`} role="alertdialog" aria-label="Push all">
          <p className="min-w-0 text-sm text-text-primary">
            Push {items.length} {items.length === 1 ? 'Pane' : 'Panes'}? Uncommitted files are committed first.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button type="button" size="sm" onClick={() => void pushAll()}>Push all</Button>
          </div>
        </div>
      )}
      {pushError && <p className={`text-sm text-status-error ${CARD_ROW}`} role="alert">{pushError}</p>}
      {load.status === 'loading' && <p className={`text-sm text-text-tertiary ${CARD_ROW}`}>Checking each Pane against its remote…</p>}
      {load.status === 'failed' && <p className={`text-sm text-status-error ${CARD_ROW}`} role="alert">{load.error}</p>}
      {load.status === 'ready' && <UnpushedWorkRows items={items} results={pushed?.results ?? null} />}
    </RemoteGroup>
  );
}

/** The listed Panes, or after Push all, what happened to each one. */
export function UnpushedWorkRows({ items, results }: { items: RunpaneHostUnpushedItem[]; results: RunpaneHostPushResult[] | null }) {
  if (results) {
    return (
      <>
        {results.map((result) => (
          <Row key={result.paneId} title={result.paneName} detail={describePushResult(result)} tone={result.outcome === 'pushed' ? 'done' : 'problem'} />
        ))}
      </>
    );
  }
  if (items.length === 0) return <p className={`text-sm text-text-tertiary ${CARD_ROW}`}>Everything here is on GitHub.</p>;
  return (
    <>
      {items.map((item) => (
        <Row key={item.paneId} title={item.paneName} detail={[item.branch, describeUnpushed(item)].filter(Boolean).join(' · ')} />
      ))}
    </>
  );
}

function Row({ title, detail, tone }: { title: string; detail: string; tone?: 'done' | 'problem' }) {
  const detailClass = tone === 'done' ? 'text-status-success' : tone === 'problem' ? 'text-status-error' : 'text-text-tertiary';
  return (
    <div className={CARD_ROW}>
      <p className="truncate text-sm font-medium text-text-primary">{title}</p>
      <p className={`text-xs ${detailClass}`}>{detail}</p>
    </div>
  );
}

function describeUnpushed({ safetyCheck: check }: RunpaneHostUnpushedItem): string {
  if (!check.performed) return "Couldn't check";
  const parts: string[] = [];
  const commits = check.unpushedCommits ?? 0;
  if (commits > 0) parts.push(`${commits} ${commits === 1 ? 'commit' : 'commits'}`);
  if (check.hasUncommittedChanges || check.hasUntrackedFiles) parts.push('uncommitted files');
  if (check.busyAgents?.some((agent) => agent.state === 'working')) parts.push('agent working');
  return parts.join(' · ');
}

function describePushResult(result: RunpaneHostPushResult): string {
  if (result.outcome === 'pushed') {
    return `${result.committedWip ? 'Committed as WIP and pushed' : 'Pushed'} to ${result.pushedTo ?? 'its remote'}`;
  }
  return `${result.outcome === 'skipped' ? 'Skipped' : 'Failed'}: ${result.message ?? 'nothing was pushed.'}`;
}
