import { useState } from 'react';
import { ArrowUp, Bell, ChevronRight, CircleCheck, FileText, Shield } from 'lucide-react';
import { cn } from '../../utils/cn';
import { moveAutopilotStack, useAutopilotStore } from '../../stores/autopilotStore';
import { showActionError } from '../../stores/errorStore';
import { awaySummary, parseLogEntries, type SentinelLogEntry } from '../../../../shared/autopilotTranscript';

const KIND = {
  answered: { label: 'Answered', Icon: CircleCheck, tone: 'text-status-success' },
  nudged: { label: 'Nudged', Icon: ChevronRight, tone: 'text-text-tertiary' },
  sent: { label: 'Sent to you', Icon: Bell, tone: 'text-status-warning' },
} as const;

function EntryIcon({ entry }: { entry: SentinelLogEntry }) {
  const { Icon, tone } = KIND[entry.kind];
  return <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone)} aria-hidden="true" />;
}

/** An `autopilot-log` block: Sentinel's calls as it makes them (round 7, d1), one line each. */
export function SentinelLogRows({ content }: { content: string }) {
  const entries = parseLogEntries(content);
  if (entries.length === 0) return null;
  return (
    <div className="my-1.5 flex flex-col gap-1" data-testid="autopilot-log">
      {entries.map((entry, index) => (
        <div key={`${entry.at}-${index}`} className="flex items-start gap-2 self-start rounded-xl bg-autopilot-subtle px-3 py-1.5 text-[13px]">
          <EntryIcon entry={entry} />
          <span className="min-w-0">
            <b className="font-semibold text-text-primary">{KIND[entry.kind].label}</b>{' '}
            <span className="text-text-secondary">{entry.session}{entry.session ? ' · ' : ''}{entry.what}{entry.why ? ` (${entry.why})` : ''}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Puts the away log on the stack and shows it on the right. */
function openLog(file: string): void {
  void window.electronAPI.autopilot.push({ file, title: 'Away log' })
    .then((snapshot) => {
      useAutopilotStore.setState({ snapshot });
      const entry = snapshot.stack.entries.find((candidate) => candidate.ref.kind === 'file' && candidate.ref.path === file);
      if (entry) moveAutopilotStack({ type: 'show', id: entry.id });
    })
    .catch((error: Error) => showActionError('Could not open the away log', error));
}

/** "Tell a Session otherwise": the person's correction goes to Autopilot, which relays it as theirs. */
function Correction({ sessions }: { sessions: string[] }) {
  const panelId = useAutopilotStore((state) => state.snapshot?.panelId);
  const [session, setSession] = useState(sessions[0] ?? '');
  const [text, setText] = useState('');
  const send = () => {
    if (!panelId || !text.trim()) return;
    const message = `Tell ${session || 'that Session'} otherwise, from me: ${text.trim()}`;
    void window.electronAPI.chatTab.send(panelId, { operationId: crypto.randomUUID(), text: message })
      .then(() => setText(''))
      .catch((error: Error) => showActionError('Could not send the correction', error));
  };
  return (
    <form className="flex flex-wrap items-center gap-2 border-t border-border-primary px-3.5 py-2.5" onSubmit={(event) => { event.preventDefault(); send(); }} data-testid="autopilot-away-correction">
      {sessions.length > 1 && (
        <select value={session} onChange={(event) => setSession(event.target.value)} aria-label="Which Session"
          className="h-8 rounded-lg bg-surface-tertiary px-2 text-[13px] text-text-primary">
          {sessions.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      )}
      <input value={text} onChange={(event) => setText(event.target.value)} placeholder={`What should ${session || 'it'} do instead?`} aria-label="Your correction"
        className="h-8 min-w-0 flex-1 rounded-lg bg-surface-tertiary px-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle" />
      <button type="submit" disabled={!text.trim()} aria-label="Send correction" className="flex h-8 w-8 items-center justify-center rounded-full bg-interactive text-text-on-interactive disabled:opacity-40">
        <ArrowUp className="h-4 w-4" />
      </button>
    </form>
  );
}

/**
 * An `autopilot-away` block (round 7, d2): what Sentinel did while the person was away, with its
 * sources, a way to tell a Session otherwise, and the full away log.
 */
export function SentinelAwayCard({ content }: { content: string }) {
  const [correcting, setCorrecting] = useState(false);
  const summary = awaySummary(content);
  const entries = parseLogEntries(content);
  const count = (kind: SentinelLogEntry['kind']) => entries.filter((entry) => entry.kind === kind).length;
  const sessions = [...new Set(entries.map((entry) => entry.session).filter(Boolean))];
  return (
    <div className="my-2 overflow-hidden rounded-2xl bg-surface-primary shadow-card ring-1 ring-autopilot-border" data-testid="autopilot-away">
      <div className="flex items-start gap-2.5 border-b border-border-primary px-3.5 py-3">
        <Shield className="mt-0.5 h-4 w-4 shrink-0 text-autopilot" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold text-text-primary">While you were away</span>
          <span className="block text-[12.5px] text-text-tertiary">
            {summary ? `${summary.from}–${summary.to} · ` : ''}{count('answered')} answered · {count('nudged')} nudged · {count('sent')} sent to you
          </span>
        </span>
      </div>
      {entries.length === 0 && <p className="px-3.5 py-3 text-[13px] text-text-tertiary">Nothing needed a call while you were away.</p>}
      {entries.map((entry, index) => (
        <div key={`${entry.at}-${index}`} className="flex items-start gap-2.5 border-t border-border-primary px-3.5 py-2.5 first:border-t-0">
          <EntryIcon entry={entry} />
          <span className="min-w-0 flex-1 text-[13.5px]">
            <b className="font-semibold text-text-primary">{KIND[entry.kind].label}</b>{' '}
            <span className="text-text-primary">{entry.session}{entry.session ? ': ' : ''}{entry.what}</span>
            {entry.why && <span className="block text-[12.5px] text-text-tertiary">{entry.why}</span>}
          </span>
          <span className="shrink-0 text-[12px] tabular-nums text-text-tertiary">{entry.at}</span>
        </div>
      ))}
      {correcting && <Correction sessions={sessions} />}
      <div className="flex flex-wrap gap-2 border-t border-border-primary px-3.5 py-2.5">
        <button type="button" onClick={() => setCorrecting((open) => !open)} aria-expanded={correcting}
          className="inline-flex h-8 items-center rounded-lg border border-border-secondary px-3 text-[13px] text-text-primary hover:bg-surface-hover">
          Tell a Session otherwise
        </button>
        {summary?.log && (
          <button type="button" onClick={() => openLog(summary.log ?? '')}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-secondary px-3 text-[13px] text-text-primary hover:bg-surface-hover">
            <FileText className="h-3.5 w-3.5" aria-hidden="true" /> Open away-log.html
          </button>
        )}
      </div>
    </div>
  );
}
