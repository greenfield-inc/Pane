import { useEffect, useState } from 'react';
import type { NotifyItem } from '../../../../shared/types/notify';
import { cn } from '../../utils/cn';
import { machineDocFailure, machineFileLinks, readMachineDoc, type MachineDoc } from './machineDoc';

/** One linked document, read from the item's machine. A failure is one line, and nothing keeps spinning. */
function MachineDocument({ item, path, label, machine }: { item: NotifyItem; path: string; label: string; machine: string }) {
  const [doc, setDoc] = useState<MachineDoc | null>(null);
  useEffect(() => {
    let live = true;
    setDoc(null);
    void readMachineDoc(item, path).then((result) => { if (live) setDoc(result); });
    return () => { live = false; };
    // The item's id and machine stay with its key; a new snapshot of it isn't a new document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  if (!doc) return <p className="m-auto text-[13px] text-text-tertiary" role="status">Opening {label}…</p>;
  const failure = machineDocFailure(doc, label, machine);
  if (failure) return <p className="m-auto max-w-sm text-center text-[13px] text-text-secondary" role="status" data-testid="approvals-doc-failed">{failure}</p>;
  if (doc.kind === 'html') {
    // Another machine's page: scripts may run, but it reaches nothing of Pane's.
    return <iframe title={label} srcDoc={doc.html} sandbox="allow-scripts" className="min-h-0 w-full flex-1 border-0" data-testid="approvals-machine-page" />;
  }
  return (
    <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-[12.5px] leading-relaxed text-text-primary" data-testid="approvals-machine-text">
      {doc.kind === 'text' ? doc.text : ''}
    </pre>
  );
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
