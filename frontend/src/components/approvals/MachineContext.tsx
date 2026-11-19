import { useEffect, useState } from 'react';
import type { NotifyItem } from '../../../../shared/types/notify';
import { cn } from '../../utils/cn';
import { Bone, Skeleton, SkeletonSwap, LoadingStatus } from '../ui/Skeleton';
import { FittedImage } from '../autopilot/AutopilotDocument';
import { ATTACHMENT_FRAME_SANDBOX } from '../todos/page/attachmentPage';
import { machineDocFailure, machineFileLinks, readMachineDoc, type MachineDoc } from './machineDoc';

/**
 * What a linked document from another machine shows: opening, its page, image or text, or one line saying
 * why not, with Retry when the machine didn't answer.
 */
export function MachineDocView({ doc, label, machine, onRetry }: { doc: MachineDoc | null; label: string; machine: string; onRetry?: () => void }) {
  const failure = doc && machineDocFailure(doc, label, machine);
  if (doc && failure) {
    return (
      <div className="m-auto max-w-sm text-center text-[13px] text-text-secondary" role="status" data-testid="approvals-doc-failed">
        <p>{failure}</p>
        {doc.kind === 'unreachable' && onRetry && (
          <button type="button" onClick={onRetry} className="mt-2 font-medium text-interactive hover:underline" data-testid="approvals-doc-retry">Retry</button>
        )}
      </div>
    );
  }
  const skeleton = (
    <>
      <LoadingStatus label={`Opening ${label}`} />
      {/* The document's text, as the pre below lays it out. */}
      <Skeleton className="min-h-0 flex-1 px-5 py-4">
        {['w-1/3', '', 'w-full', 'w-11/12', 'w-4/5', '', 'w-full', 'w-2/3', 'w-5/6', 'w-1/2'].map((width, index) => (
          <div key={index} className="flex h-5 items-center">{width && <Bone className={`h-2.5 ${width}`} />}</div>
        ))}
      </Skeleton>
    </>
  );
  return (
    <SkeletonSwap loading={!doc} skeleton={skeleton}>
      {doc?.kind === 'html'
        // Another machine's page, sent as text: no scripts (Pane's own content policy would block them anyway), no forms, no navigation.
        ? <iframe title={label} srcDoc={doc.html} sandbox={ATTACHMENT_FRAME_SANDBOX} className="min-h-0 w-full flex-1 border-0" data-testid="approvals-machine-page" />
        : doc?.kind === 'image'
          ? <FittedImage src={doc.dataUrl} label={label} />
          : doc && <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-[12.5px] leading-relaxed text-text-primary" data-testid="approvals-machine-text">
          {doc.kind === 'text' ? doc.text : ''}
        </pre>}
    </SkeletonSwap>
  );
}

/** One linked document, read from the item's machine. A failure is one line, and nothing keeps spinning. */
export function MachineDocument({ item, path, label, machine }: { item: Pick<NotifyItem, 'machineId'>; path: string; label: string; machine: string }) {
  const [doc, setDoc] = useState<MachineDoc | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setDoc(null);
    void readMachineDoc(item, path).then((result) => { if (live) setDoc(result); });
    return () => { live = false; };
    // The item's id and machine stay with its key; a new snapshot of it isn't a new document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, attempt]);
  const retry = () => {
    setDoc(null);
    // Reconnect now rather than at the machine's next scheduled retry, then read again.
    const machineId = item.machineId ?? 'local';
    const reconnect = machineId === 'local' ? Promise.resolve() : window.electronAPI.machines.retry(machineId).catch(() => undefined);
    void reconnect.then(() => setAttempt((current) => current + 1));
  };
  return <MachineDocView doc={doc} label={label} machine={machine} onRetry={retry} />;
}

/**
 * Beside another machine's item (J21): its linked documents, read from that machine. This
 * computer's terminals never mount for it. The header above names the Session and opens it there.
 */
export function MachineContext({ item, machine, connectedName }: { item: NotifyItem; machine: string; connectedName: string }) {
  const docs = machineFileLinks(item);
  const [shown, setShown] = useState(0);
  const doc = docs[Math.min(shown, docs.length - 1)];
  if (!doc) {
    return (
      <div className="m-auto max-w-sm text-center text-[13px] text-text-secondary" data-testid="approvals-elsewhere">
        <p>{connectedName} runs on {machine}.</p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="approvals-elsewhere">
      {docs.length > 1 && (
        <div role="tablist" aria-label="Documents" className="scrollbar-thin flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-border-primary px-3">
          {docs.map((candidate, index) => (
            <button key={candidate.path} type="button" role="tab" aria-selected={candidate.path === doc.path} onClick={() => setShown(index)}
              className={cn('inline-flex h-9 shrink-0 items-center border-b-2 px-2.5 text-[13px]', candidate.path === doc.path ? 'border-text-primary font-medium text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary')}>
              <span className="max-w-[180px] truncate">{candidate.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MachineDocument key={doc.path} item={item} path={doc.path} label={doc.label} machine={machine} />
      </div>
    </div>
  );
}
