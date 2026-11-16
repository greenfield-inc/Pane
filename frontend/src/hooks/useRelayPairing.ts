import { useCallback, useEffect, useRef, useState } from 'react';
import type { RelayPairingInfo, RelayStatus } from '../../../shared/types/relay';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';

/** What Add a device › Phone shows in its code box. */
export type PairingView =
  | { step: 'preparing' }
  | { step: 'error'; message: string }
  | { step: 'code'; url: string; secondsLeft: number }
  /** The last code ran out; a new one is on its way. */
  | { step: 'renewing' };

const SETUP_FAILED = "Pane's servers didn't answer";

/**
 * Pairing while `open`: turns phone access on if it is off and waits for this computer to be ready.
 * With `showCode` it keeps one current 10-minute pairing code; a used code (`relay:paired`) or an
 * expired one is replaced at once. Phone access it turned on is turned off again if it closes before
 * ever being ready.
 */
export function useRelayPairing(open: boolean, showCode = true) {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [code, setCode] = useState<RelayPairingInfo | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** The phone that used the last code, until the dialog closes. */
  const [paired, setPaired] = useState<string | null>(null);
  /** Why the current code replaced an earlier one. */
  const [renewal, setRenewal] = useState<'paired' | 'expired' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Bumped per request and on close, so a late answer never lands on a newer state.
  const generation = useRef(0);
  const requesting = useRef(false);
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
      if (asked === generation.current) setFailure(ipcErrorMessage(cause, SETUP_FAILED));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setStatus(null);
    setCode(null);
    setFailure(null);
    setPaired(null);
    setRenewal(null);
    void prepare(false);
    const offStatus = window.electronAPI.events.onRelayStatusChanged((next) => setStatus(next));
    const offPaired = window.electronAPI.events.onRelayPaired(({ kind, label }) => {
      // A computer that used a copied link spent its own secret, not this code (Add a device › Computer shows it).
      if (kind === 'computer') return;
      setPaired(label);
      setRenewal('paired');
      setCode(null);
    });
    return () => {
      generation.current += 1;
      requesting.current = false;
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
    if (!ready || !showCode || code || failure || requesting.current) return;
    requesting.current = true;
    const asked = ++generation.current;
    window.electronAPI.invoke('relay:pairing-code').then(
      (next: RelayPairingInfo) => {
        if (asked !== generation.current) return;
        requesting.current = false;
        setNow(Date.now());
        setCode(next);
      },
      (cause: Error) => {
        if (asked !== generation.current) return;
        requesting.current = false;
        setFailure(ipcErrorMessage(cause, "Pane couldn't make a pairing code"));
      },
    );
  }, [ready, showCode, code, failure]);

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
    requesting.current = false;
    setCode(null);
    void prepare(true);
  }, [prepare]);

  let view: PairingView;
  if (failure) view = { step: 'error', message: failure };
  else if (status?.phase === 'error') view = { step: 'error', message: status.lastError ?? SETUP_FAILED };
  else if (code && expiresAt !== null) view = { step: 'code', url: code.url, secondsLeft: Math.max(0, Math.ceil((expiresAt - now) / 1000)) };
  else if (renewal === 'expired' && status?.phase === 'ready') view = { step: 'renewing' };
  else view = { step: 'preparing' };

  return { view, ready, paired, renewal, retry, relay: status?.relay ?? null };
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
