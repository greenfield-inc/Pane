import { useState } from 'react';
import { CheckCircle2, Clipboard } from 'lucide-react';
import { Button } from '../ui/Button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { LINK_EXPIRY_LABELS, useAddDeviceStore, type LinkExpiry, type MakerResult } from './addDeviceStore';
import { LinkFlowView } from './LinkConfirm';
import { TabFooter } from './SshTab';

const EXPIRIES: LinkExpiry[] = ['10m', '1h', '24h'];
const CARD = 'flex min-w-0 flex-1 flex-col gap-3 rounded-lg border border-border-primary p-5';

function isExpiry(value: string): value is LinkExpiry {
  return value in LINK_EXPIRY_LABELS;
}

/** The first computer's view once its link is used: who linked, and "Not you? Unlink". */
export function MakerResultView({ maker }: { maker: MakerResult }) {
  const unlinkMaker = useAddDeviceStore((state) => state.unlinkMaker);
  const close = useAddDeviceStore((state) => state.close);
  return (
    <div className="space-y-4">
      <div role="status" className="flex items-start gap-3 rounded-lg border border-status-success/30 bg-status-success/10 p-3">
        <CheckCircle2 className="mt-0.5 h-5 w-5 flex-none text-status-success" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">Linked with {maker.label}</p>
          <p className="text-xs text-text-secondary">{maker.label} now reaches this computer and the computers linked with it.</p>
        </div>
      </div>
      {maker.unlink === 'done' ? (
        <p className="text-sm text-text-secondary" role="status">{maker.outcome}</p>
      ) : maker.computerId && (
        <p className="text-sm text-text-secondary">
          Not you?{' '}
          <button
            type="button"
            disabled={maker.unlink === 'busy'}
            onClick={() => void unlinkMaker()}
            className="text-interactive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle disabled:opacity-50"
          >
            Unlink {maker.label}
          </button>
        </p>
      )}
      <TabFooter><Button type="button" variant="secondary" onClick={close}>Done</Button></TabFooter>
    </div>
  );
}

/** Add a device › Computer: copy a one-time link with a chosen lifetime, or paste one made on the other computer. */
export function ComputerTab({ ready }: { ready: boolean }) {
  const { expiresIn, setExpiresIn, copied, copyError, copyLink, flow, startLink, cancelLink, maker } = useAddDeviceStore();
  const [pasted, setPasted] = useState('');
  const [copying, setCopying] = useState(false);

  if (maker) return <MakerResultView maker={maker} />;
  if (flow.step !== 'idle' && flow.source === 'paste') {
    return <LinkFlowView flow={flow} onDone={() => { cancelLink(); setPasted(''); }} />;
  }

  const copy = () => {
    setCopying(true);
    void copyLink().finally(() => setCopying(false));
  };
  let copyNote = `Works once. Choose ${LINK_EXPIRY_LABELS['10m']}, ${LINK_EXPIRY_LABELS['1h']} or ${LINK_EXPIRY_LABELS['24h']}.`;
  if (copied) copyNote = `Copied. It works once, until ${new Date(copied.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`;

  return (
    <>
    <div className="flex flex-col gap-4 sm:flex-row">
      <section className={CARD} aria-labelledby="add-device-start">
        <div className="space-y-1">
          <h3 id="add-device-start" className="text-sm font-semibold text-text-primary">Start here</h3>
          <p className="text-sm text-text-secondary">Send this link to your other computer and open it there. It also works on a phone or in a browser.</p>
        </div>
        <Button type="button" fullWidth icon={<Clipboard className="h-4 w-4" />} disabled={!ready || copying} onClick={copy}>
          {ready ? 'Copy link' : 'Getting this computer ready…'}
        </Button>
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="add-device-expiry" className="text-sm text-text-secondary">Expires after</label>
          <Select value={expiresIn} onValueChange={(next) => { if (isExpiry(next)) setExpiresIn(next); }}>
            <SelectTrigger id="add-device-expiry" className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              {EXPIRIES.map((value) => <SelectItem key={value} value={value}>{LINK_EXPIRY_LABELS[value]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-text-tertiary" role={copied ? 'status' : undefined}>{copyNote}</p>
        {copyError && <p className="text-xs text-status-error" role="alert">{copyError}</p>}
      </section>
      <section className={CARD} aria-labelledby="add-device-finish">
        <div className="space-y-1">
          <h3 id="add-device-finish" className="text-sm font-semibold text-text-primary">Or finish here</h3>
          <p className="text-sm text-text-secondary">Copied a link on the other computer? Paste it.</p>
        </div>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void startLink(pasted, 'paste');
          }}
        >
          <input
            aria-label="Paste link"
            placeholder="Paste link"
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            className="w-full rounded-input border border-border-primary bg-bg-primary px-input-x py-input-y text-sm text-text-primary placeholder:text-text-muted focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-interactive"
          />
          <Button type="submit" variant="secondary" fullWidth disabled={pasted.trim() === ''}>Link</Button>
        </form>
      </section>
    </div>
    <TabFooter>
      <p className="mr-auto text-sm text-text-secondary">Whatever opens the link joins all your linked computers. Only link computers you own.</p>
    </TabFooter>
    </>
  );
}
