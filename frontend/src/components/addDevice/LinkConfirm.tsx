import { useMemo } from 'react';
import { AlertCircle, CheckCircle2, Link2, Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { MachineMark } from '../machines/MachineMark';
import { assignMachineLetters } from '../../../../shared/utils/machineMarks';
import { preferredMachineColorSlot } from '../../../../shared/utils/machineColor';
import { useAddDeviceStore, type LinkFlow } from './addDeviceStore';
import { Bone, Skeleton, TextBone, LoadingStatus } from '../ui/Skeleton';

function useMarks(names: string[]) {
  const key = names.join('\n');
  // Keyed by the joined names so a new array with the same names keeps the letters.
  return useMemo(() => assignMachineLetters(key.split('\n')), [key]);
}

/** "Link this computer with <maker>": every computer on both sides, before the maker can run agents here. */
function ConfirmLink({ flow }: { flow: Extract<LinkFlow, { step: 'confirm' }> }) {
  const { preview, here } = flow;
  const { confirmLink, cancelLink } = useAddDeviceStore();
  const makerGroup = [preview.maker, ...preview.makerGroup.filter((name) => name !== preview.maker)];
  const marks = useMarks([here, ...makerGroup, ...preview.here]);
  const mark = (name: string) => (
    <MachineMark letters={marks.get(name) ?? '?'} slot={preferredMachineColorSlot(name)} size="md" />
  );
  const rows: Array<{ name: string; tag?: string }> = [
    ...makerGroup.map((name) => ({ name, tag: name === preview.maker ? 'made this link' : undefined })),
    ...preview.here.map((name) => ({ name, tag: `linked with ${here}` })),
  ];

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="flex items-center gap-3" aria-hidden="true">
        {mark(here)}
        <Link2 className="h-5 w-5 text-text-tertiary" />
        {mark(preview.maker)}
      </div>
      <div className="space-y-1">
        <h2 className="text-heading-1 text-text-primary">Link this computer with {preview.maker}</h2>
        <p className="text-sm text-text-secondary">Linking lets {preview.maker} run agents on {here}. Once linked, {here} and each computer below can run agents on each other.</p>
      </div>
      <ul className="w-full max-w-md divide-y divide-border-primary overflow-hidden rounded-lg border border-border-primary text-left" aria-label="Computers on both sides">
        {rows.map(({ name, tag }) => (
          <li key={name} className="flex items-center gap-3 px-3 py-2.5">
            {mark(name)}
            <span className="truncate text-sm text-text-primary">{name}</span>
            {tag && <span className="flex-none rounded bg-surface-secondary px-1.5 py-0.5 text-xs text-text-secondary">{tag}</span>}
          </li>
        ))}
      </ul>
      <div className="flex gap-3">
        <Button type="button" variant="secondary" onClick={cancelLink}>Not mine, cancel</Button>
        <Button type="button" onClick={() => void confirmLink()}>Link {here}</Button>
      </div>
    </div>
  );
}

/** ConfirmLink while the link is read: both marks, the heading, the computers list and the buttons. */
function ConfirmLinkSkeleton() {
  return (
    <>
      <LoadingStatus label="Reading the link" />
      <Skeleton className="flex flex-col items-center gap-5">
        <div className="flex items-center gap-3">
          <Bone className="h-7 w-7 rounded-md" />
          <Bone className="h-5 w-5" />
          <Bone className="h-7 w-7 rounded-md" />
        </div>
        <div className="flex w-full flex-col items-center space-y-1">
          <div className="text-heading-1"><TextBone text="Link this computer with a computer" /></div>
          <div className="flex h-5 w-full items-center justify-center"><Bone className="h-3.5 w-[90%]" /></div>
          <div className="flex h-5 w-full items-center justify-center"><Bone className="h-3.5 w-1/2" /></div>
        </div>
        <div className="w-full max-w-md divide-y divide-border-primary rounded-lg border border-border-primary">
          {[40, 52].map((width, index) => (
            <div key={index} className="flex items-center gap-3 px-3 py-2.5">
              <Bone className="h-7 w-7 rounded-md" />
              <Bone className="h-3.5" style={{ width: `${width}%` }} />
            </div>
          ))}
        </div>
        <div className="flex gap-3">
          <Bone className="h-9 w-36 rounded-button" />
          <Bone className="h-9 w-40 rounded-button" />
        </div>
      </Skeleton>
    </>
  );
}

/** Every step of a link after it is pasted or opened: checking, the confirm, linking, the result, or why it failed. */
export function LinkFlowView({ flow, onDone }: { flow: Exclude<LinkFlow, { step: 'idle' }>; onDone: () => void }) {
  if (flow.step === 'confirm') return <ConfirmLink flow={flow} />;
  if (flow.step === 'checking') return <ConfirmLinkSkeleton />;
  if (flow.step === 'linking') {
    return (
      <div role="status" className="flex flex-col items-center gap-3 py-8 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-text-tertiary" aria-hidden="true" />
        <p className="text-sm text-text-secondary">Linking with {flow.maker}…</p>
      </div>
    );
  }
  if (flow.step === 'linked') {
    const others = flow.linked.filter((name) => name !== flow.maker).length;
    return (
      <div className="flex w-full flex-col gap-4">
        <div role="status" className="flex items-start gap-3 rounded-lg border border-status-success/30 bg-status-success/10 p-3 text-left">
          <CheckCircle2 className="mt-0.5 h-5 w-5 flex-none text-status-success" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">Linked with {flow.maker}</p>
            <p className="text-xs text-text-secondary">
              This computer now reaches {flow.maker}{others > 0 ? ` and ${others} other ${others === 1 ? 'computer' : 'computers'}` : ''}.
            </p>
          </div>
        </div>
        <div className="flex justify-end"><Button type="button" variant="secondary" onClick={onDone}>Done</Button></div>
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col gap-4">
      <div role="alert" className="flex items-start gap-3 rounded-lg border border-status-error/30 bg-status-error/10 p-3 text-left">
        <AlertCircle className="mt-0.5 h-5 w-5 flex-none text-status-error" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">{flow.message}</p>
          <p className="text-xs text-text-secondary">Nothing was linked. Copy a new link on the other computer and try again.</p>
        </div>
      </div>
      <div className="flex justify-end"><Button type="button" variant="secondary" onClick={onDone}>Done</Button></div>
    </div>
  );
}

/** The full page a `pane://pair` link opens on: the confirm, or the result when nothing linked here. */
export function LinkConfirmPage() {
  const flow = useAddDeviceStore((state) => state.flow);
  const cancelLink = useAddDeviceStore((state) => state.cancelLink);
  if (flow.step === 'idle' || flow.source !== 'opened') return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-bg-primary p-6" role="dialog" aria-modal="true" aria-label="Link this computer">
      <div className="w-full max-w-xl">
        <LinkFlowView flow={flow} onDone={cancelLink} />
      </div>
    </div>
  );
}
