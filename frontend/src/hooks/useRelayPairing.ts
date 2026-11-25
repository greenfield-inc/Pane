import { useCallback, useEffect, useRef, useState } from 'react';
import type { RelayPairingInfo, RelayStatus } from '../../../shared/types/relay';
import type { DeviceAccess } from '../../../shared/types/accessLevel';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { capture } from '../services/posthog';
import { PairingReport } from './pairingReport';

/** What Add a device › Phone shows in its code box. */
export type PairingView =
  /** `label` says what this computer is waiting for. */
  | { step: 'preparing'; label: string }
  /** `cause` says whether phone access couldn't start (`relay`) or only the code failed (`code`). */
  | { step: 'error'; message: string; cause: 'relay' | 'code' }
  /** The CA is turning this computer away until `until`: the relay pairs no new devices; Tailscale still works. */
  | { step: 'limited'; until: string }
  | { step: 'code'; url: string; secondsLeft: number }
  /** The last code ran out; a new one is on its way. */
  | { step: 'renewing' };

const SETUP_FAILED = "Pane's servers didn't answer. Check this computer's internet connection, then choose Try again.";

/**
 * Pairing while `open`: turns phone access on if it is off and waits for this computer to be ready.
 * With `showCode` it keeps one current 10-minute pairing code; a used code (`relay:paired`) or an
 * expired one is replaced at once. Phone access it turned on is turned off again if it closes before
 * ever being ready. `dialogOpen` (default `open`) is how long one opening of the dialog lasts, for
 * its pairing report: switching to a tab that doesn't use the relay and back is the same opening.
 * `access` is what the code gives; changing it makes a new code, and one for another level is never shown.
 */
export function useRelayPairing(open: boolean, showCode = true, dialogOpen = open, access: DeviceAccess = 'full') {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [made, setCode] = useState<(RelayPairingInfo & { access: DeviceAccess }) | null>(null);
  const code = made?.access === access ? made : null;
  const [failure, setFailure] = useState<{ message: string; cause: 'relay' | 'code' } | null>(null);
  /** The phone that used the last code, until the dialog closes. */
  const [paired, setPaired] = useState<{ label: string; readOnly: boolean } | null>(null);
  /** Why the current code replaced an earlier one. */
  const [renewal, setRenewal] = useState<'paired' | 'expired' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** False until this opening's state is reset, so the first render after reopening isn't read as this opening's. */
  const [fresh, setFresh] = useState(false);
  // Bumped per request and on close, so a late answer never lands on a newer state.
  const generation = useRef(0);
  /** The level of the code being made. */
  const requesting = useRef<DeviceAccess | null>(null);
  /** Set when this opening turned phone access on: whether the host listener was already on. */
  const turnedOn = useRef<{ hostWasOn: boolean } | null>(null);
  const reachedReady = useRef(false);

  /** Reads the status and turns phone access on when it is off, or always when `restart` is set. */
  const prepare = useCallback(async (restart: boolean) => {
    const asked = generation.current;
    setFailure(null);
    try {
      let next: RelayStatus = await window.electronAPI.invoke('relay:status');
      if (!next.enabled && !turnedOn.current) {
        const config = await window.electronAPI.remoteDaemon.getConfig();
        turnedOn.current = { hostWasOn: config.data?.host.config.enabled === true };
      }
      if (restart || !next.enabled) next = await window.electronAPI.invoke('relay:set-enabled', true);
      if (asked === generation.current) setStatus(next);
    } catch (cause) {
      if (asked === generation.current) setFailure({ message: ipcErrorMessage(cause, SETUP_FAILED), cause: 'relay' });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setStatus(null);
    setCode(null);
    setFailure(null);
    setPaired(null);
    setRenewal(null);
    setFresh(true);
    void prepare(false);
    const offStatus = window.electronAPI.events.onRelayStatusChanged((next) => setStatus(next));
    const offPaired = window.electronAPI.events.onRelayPaired(({ kind, label, access: pairedAccess }) => {
      // A computer that used a copied link spent its own secret, not this code (Add a device › Computer shows it).
      if (kind === 'computer') return;
      setPaired({ label, readOnly: pairedAccess === 'read' });
      setRenewal('paired');
      setCode(null);
    });
    return () => {
      generation.current += 1;
      requesting.current = null;
      setFresh(false);
      offStatus();
      offPaired();
      const undo = reachedReady.current ? null : turnedOn.current;
      turnedOn.current = null;
      reachedReady.current = false;
      if (undo) void turnOff(undo.hostWasOn);
    };
  }, [open, prepare]);

  const ready = open && status?.phase === 'ready';
  useEffect(() => {
    if (ready) reachedReady.current = true;
    if (!ready || !showCode || code || failure || requesting.current === access) return;
    requesting.current = access;
    const asked = ++generation.current;
    window.electronAPI.invoke('relay:pairing-code', { access }).then(
      (next: RelayPairingInfo) => {
        if (asked !== generation.current) return;
        requesting.current = null;
        setNow(Date.now());
        setCode({ ...next, access });
      },
      (cause: Error) => {
        if (asked !== generation.current) return;
        requesting.current = null;
        setFailure({ message: ipcErrorMessage(cause, "Pane couldn't make a pairing code. Choose Try again."), cause: 'code' });
      },
    );
  }, [ready, showCode, code, failure, access]);

  const expiresAt = code ? Date.parse(code.expiresAt) : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      if (at >= expiresAt) {
        setRenewal('expired');
        setCode(null);
      }
    };
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  const retry = useCallback(() => {
    generation.current += 1;
    requesting.current = null;
    setCode(null);
    void prepare(true);
  }, [prepare]);

  let view: PairingView;
  if (status?.certificateLimit) view = { step: 'limited', until: status.certificateLimit.until };
  else if (failure) view = { step: 'error', ...failure };
  else if (status?.phase === 'error') view = { step: 'error', message: status.lastError ?? SETUP_FAILED, cause: 'relay' };
  else if (code && expiresAt !== null) view = { step: 'code', url: code.url, secondsLeft: Math.max(0, Math.ceil((expiresAt - now) / 1000)) };
  else if (renewal === 'expired' && !made && status?.phase === 'ready') view = { step: 'renewing' };
  else if (status?.phase === 'certificate') view = { step: 'preparing', label: 'Getting a certificate…' };
  else view = { step: 'preparing', label: status?.phase === 'ready' ? 'Making a code…' : 'Connecting to Pane…' };

  // Each opening of the dialog reports once (PairingReport), across tab switches; only the Phone tab shows a code.
  const report = useRef<PairingReport | null>(null);
  useEffect(() => {
    if (!dialogOpen) return;
    const opening = new PairingReport(capture);
    report.current = opening;
    return () => {
      opening.close();
      report.current = null;
    };
  }, [dialogOpen]);
  useEffect(() => {
    if (open && fresh && showCode) report.current?.observe(view);
  }, [open, fresh, showCode, view]);

  return { view, ready, paired: paired?.label ?? null, pairedReadOnly: paired?.readOnly ?? false, renewal, retry, relay: status?.relay ?? null };
}

/** Undoes a pairing attempt that never got ready, so later launches don't keep retrying the relay. */
async function turnOff(hostWasOn: boolean): Promise<void> {
  try {
    await window.electronAPI.invoke('relay:set-enabled', false);
    if (!hostWasOn) await window.electronAPI.remoteDaemon.updateHostConfig({ enabled: false });
  } catch (cause) {
    console.warn('[relay] Could not turn phone access back off:', cause);
  }
}

/** When Pane relay pairs no new devices because of the CA's limit, until when; read without turning phone access on. */
export function useRelayCertificateLimit(): string | null {
  const [until, setUntil] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.electronAPI.invoke('relay:status').then(
      (status: RelayStatus) => { if (live) setUntil(status.certificateLimit?.until ?? null); },
      () => undefined,
    );
    const off = window.electronAPI.events.onRelayStatusChanged((status) => setUntil(status.certificateLimit?.until ?? null));
    return () => { live = false; off(); };
  }, []);
  return until;
}
