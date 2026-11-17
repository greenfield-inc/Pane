import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { cn } from '../../utils/cn';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

interface SshHost {
  alias: string;
  hostname?: string;
  user?: string;
}

/** `ssh:route-progress`, as main's `SshRouteProgress` sends it. */
interface SshProgress {
  host: string;
  step: 'connecting' | 'checking-node' | 'installing' | 'starting' | 'linked' | 'failed';
  message: string;
}

const CARD = 'flex min-w-0 flex-1 flex-col gap-3 rounded-lg border border-border-primary p-5';

/** A row and footer that span the dialog's width below a tab. */
export function TabFooter({ children }: { children: ReactNode }) {
  return <div className="-mx-6 mt-5 flex items-center justify-end gap-3 border-t border-border-primary px-6 pt-4">{children}</div>;
}

function hostDetail(host: SshHost): string | null {
  if (!host.hostname) return host.user ? `${host.user}@${host.alias}` : null;
  return host.user ? `${host.user}@${host.hostname}` : host.hostname;
}

/** Add a device › SSH: Pane connects with the person's own SSH setup, starts Pane there, and adds the computer with an SSH route. */
export function SshTab({ onClose }: { onClose: () => void }) {
  const [hosts, setHosts] = useState<SshHost[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [progress, setProgress] = useState<SshProgress | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = typed.trim() || selected;

  useEffect(() => {
    let live = true;
    window.electronAPI.invoke('ssh:route-hosts').then(
      (list: SshHost[]) => {
        if (!live) return;
        setHosts(list);
        setSelected(list[0]?.alias ?? null);
      },
      () => { if (live) setHosts([]); },
    );
    const off = window.electronAPI.events.onSshRouteProgress((event: SshProgress) => setProgress(event));
    return () => {
      live = false;
      off();
    };
  }, []);

  const connect = () => {
    if (!target) return;
    setBusy(true);
    setFailure(null);
    setProgress({ host: target, step: 'connecting', message: `Connecting to ${target}…` });
    window.electronAPI.invoke('ssh:route-connect', { host: target }).then(
      () => setProgress({ host: target, step: 'linked', message: `${target} is now one of your computers, with an SSH route.` }),
      (cause: unknown) => {
        setProgress(null);
        setFailure(ipcErrorMessage(cause, `Pane couldn't connect to ${target}`));
      },
    ).finally(() => setBusy(false));
  };

  const current = progress && progress.host === target ? progress : null;
  let status: ReactNode = null;
  if (failure || current?.step === 'failed') {
    status = (
      <p role="alert" className="flex items-start gap-2 text-sm text-text-primary">
        <AlertCircle className="mt-0.5 h-4 w-4 flex-none text-status-error" aria-hidden="true" />
        {failure ?? current?.message}
      </p>
    );
  } else if (current?.step === 'linked') {
    status = (
      <p role="status" className="flex items-start gap-2 text-sm text-text-primary">
        <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-status-success" aria-hidden="true" />
        {current.message}
      </p>
    );
  } else if (current) {
    status = (
      <p role="status" className="flex items-start gap-2 text-sm text-text-secondary">
        <Loader2 className="mt-0.5 h-4 w-4 flex-none animate-spin" aria-hidden="true" />
        {current.message}
      </p>
    );
  }

  const done = current?.step === 'linked';
  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row">
        <section className={CARD} aria-labelledby="add-device-ssh-hosts">
          <h3 id="add-device-ssh-hosts" className="text-sm font-semibold text-text-primary">Hosts in ~/.ssh/config</h3>
          {hosts === null ? (
            <p className="text-sm text-text-tertiary">Reading your SSH config…</p>
          ) : hosts.length === 0 ? (
            <p className="text-sm text-text-tertiary">No hosts in ~/.ssh/config. Type one below.</p>
          ) : (
            <ul className="space-y-1" role="listbox" aria-label="SSH hosts">
              {hosts.map((host) => {
                const isSelected = !typed.trim() && selected === host.alias;
                const detail = hostDetail(host);
                return (
                  <li key={host.alias} role="option" aria-selected={isSelected}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => { setSelected(host.alias); setTyped(''); }}
                      className={cn(
                        'flex w-full min-w-0 items-baseline gap-1.5 rounded-md px-3 py-2 text-left text-sm',
                        isSelected ? 'bg-surface-secondary' : 'hover:bg-surface-hover',
                      )}
                    >
                      <span className="text-text-primary">{host.alias}</span>
                      {detail && <span className="truncate text-text-tertiary">· {detail}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <input
            aria-label="Another host"
            placeholder="user@host"
            value={typed}
            disabled={busy}
            onChange={(event) => setTyped(event.target.value)}
            className="w-full rounded-input border border-border-primary bg-bg-primary px-input-x py-input-y text-sm text-text-primary placeholder:text-text-muted focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-interactive"
          />
        </section>
        <section className={CARD} aria-labelledby="add-device-ssh-what">
          <h3 id="add-device-ssh-what" className="text-sm font-semibold text-text-primary">What Pane does</h3>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-text-secondary">
            <li>Connects with your SSH keys</li>
            <li>Starts Pane there, installing it if missing</li>
            <li>Adds {target ?? 'the host'} to your computers, with an SSH route</li>
          </ol>
          {status}
        </section>
      </div>
      <TabFooter>
        <Button type="button" variant="secondary" onClick={onClose}>{done ? 'Done' : 'Cancel'}</Button>
        {!done && <Button type="button" disabled={!target || busy} loading={busy} onClick={connect}>Connect</Button>}
      </TabFooter>
    </>
  );
}
