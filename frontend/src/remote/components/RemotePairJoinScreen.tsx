import { ReadOnlyPill } from '../../components/machines/ReadOnlyPill';
import type { RelayLinkJoin } from '../../../../shared/remoteClient/relayLinkPreview';

interface RemotePairJoinScreenProps {
  join: RelayLinkJoin;
  onLink: () => void;
  onCancel: () => void;
}

/**
 * A pairing link for a computer this browser doesn't reach yet, opened where it reaches others: names both sides
 * and pairs only on "Link". Cancelling leaves the link unused. A read-only link names only what it lets this browser watch.
 */
export function RemotePairJoinScreen({ join, onLink, onCancel }: RemotePairJoinScreenProps) {
  const readOnly = join.access === 'read';
  return (
    <main className="flex min-h-dvh w-full items-center justify-center overflow-y-auto bg-bg-primary px-4 py-6 text-text-primary sm:p-6">
      <section className="w-full max-w-md text-center" aria-labelledby="pair-join-title">
        <h1 id="pair-join-title" className="text-xl font-semibold text-text-primary">{readOnly ? `Watch ${join.maker}` : `Link with ${join.maker}`}</h1>
        <p className="mt-2 text-sm leading-5 text-text-secondary">
          {readOnly
            ? `Read only. This browser sees the Sessions, agents, transcripts and terminal output on the computers below and can't change anything. They can't reach your computers.`
            : `Linking adds ${join.maker} and the computers linked with it to this browser.`}
        </p>
        <JoinSide title="From this link" names={join.makerGroup} maker={join.maker} readOnly={readOnly} />
        {!readOnly && <JoinSide title="In this browser" names={join.here} />}
        <div className="mt-6 flex flex-col-reverse justify-center gap-2 sm:flex-row">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 rounded-md border border-border-primary bg-surface-secondary px-4 text-sm font-medium text-text-primary hover:bg-surface-hover md:min-h-9"
          >
            Not mine, cancel
          </button>
          <button
            type="button"
            onClick={onLink}
            className="min-h-11 rounded-md bg-interactive px-4 text-sm font-semibold text-text-on-interactive hover:opacity-90 md:min-h-9"
          >
            {readOnly ? 'Watch' : 'Link'} {join.maker}
          </button>
        </div>
      </section>
    </main>
  );
}

function JoinSide({ title, names, maker, readOnly = false }: { title: string; names: string[]; maker?: string; readOnly?: boolean }) {
  return (
    <div className="mt-5 text-left">
      <h2 className="mb-2 text-sm font-semibold text-text-secondary">{title}</h2>
      <ul className="divide-y divide-border-primary rounded-lg border border-border-primary bg-surface-primary">
        {names.map(name => (
          <li key={name} className="flex min-w-0 items-center gap-2 px-3 py-2.5 text-sm text-text-primary">
            <span className="truncate">{name}</span>
            {readOnly ? <ReadOnlyPill /> : null}
            {name === maker ? <span className="shrink-0 rounded bg-surface-secondary px-1.5 py-0.5 text-xs text-text-tertiary">made this link</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
