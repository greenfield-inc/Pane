import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceCapture, DeviceLogLine, DeviceRecording } from '../../../../../shared/types/devices';
import type { AgentTab } from '../../../../../shared/deviceAgentTab';
import type { DeviceTabClient } from './deviceClient';

async function dataUrlFile(dataUrl: string, name: string): Promise<File> {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: blob.type });
}

/** A file name for a capture of `device` now, such as "iPhone 17 Pro 19.04.12.png". */
export function captureName(device: string, extension: string): string {
  const time = new Date().toTimeString().slice(0, 8).replaceAll(':', '.');
  return `${device} ${time}.${extension}`;
}

/**
 * Puts a screenshot in front of the agent, unsent: a chat tab gets it in its composer; a terminal
 * agent gets the PNG's path typed at its prompt. Answers what happened, for the card.
 */
export async function deliverCapture(client: DeviceTabClient, devicePanelId: string, target: AgentTab, capture: DeviceCapture, name: string): Promise<string> {
  if (target.kind === 'chat') {
    await client.attachToChat(target.id, await dataUrlFile(capture.dataUrl, name));
    return 'Added to chat';
  }
  await client.stage(devicePanelId, target.id, `${capture.path} `);
  return `Typed at ${target.agent}'s prompt`;
}

/** Puts text (log lines) in front of the agent, unsent: a chat gets a text file; a terminal agent gets the text at its prompt. */
export async function deliverText(client: DeviceTabClient, devicePanelId: string, target: AgentTab, text: string, name: string): Promise<void> {
  if (target.kind === 'chat') await client.attachToChat(target.id, new File([text], name, { type: 'text/plain' }));
  else await client.stage(devicePanelId, target.id, text);
}

export async function copyImage(dataUrl: string): Promise<void> {
  const blob = await (await fetch(dataUrl)).blob();
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

export function saveImage(dataUrl: string, name: string): void {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = name;
  link.click();
}

/** A recording in progress: when it started, and the seconds since, ticking each second. */
export function useRecording(client: DeviceTabClient, panelId: string) {
  const [startedAt, setStartedAt] = useState<number>();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (startedAt === undefined) return;
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const recording = startedAt !== undefined;
  // The recording lives in main: a tab shown again picks up its clock.
  useEffect(() => {
    let cancelled = false;
    void client.recording(panelId).then((started) => { if (!cancelled && started !== null) setStartedAt(started); }, () => undefined);
    return () => { cancelled = true; };
  }, [client, panelId]);
  // Main stops a recording at its 10-minute limit: while one runs, check it is still going.
  const [capped, setCapped] = useState(false);
  useEffect(() => {
    if (!recording) return;
    let cancelled = false;
    let timer: number | undefined;
    const check = async () => {
      const started = await client.recording(panelId).catch(() => undefined);
      if (cancelled) return;
      if (started === null) {
        setStartedAt(undefined);
        setCapped(true);
        return;
      }
      timer = window.setTimeout(() => { void check(); }, RECORDING_CHECK_MS);
    };
    timer = window.setTimeout(() => { void check(); }, RECORDING_CHECK_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, panelId, recording]);
  const start = useCallback(async () => {
    await client.record(panelId, 'start');
    setCapped(false);
    setStartedAt(Date.now());
  }, [client, panelId]);
  const stop = useCallback(async (): Promise<DeviceRecording> => {
    try {
      const recording = await client.record(panelId, 'stop');
      if (!recording) throw new Error('The recording did not save.');
      return recording;
    } finally {
      setStartedAt(undefined);
    }
  }, [client, panelId]);
  return { recording, elapsed, start, stop, capped };
}

/** How often a running recording checks it has not stopped at its limit. */
const RECORDING_CHECK_MS = 5_000;

export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const LOG_POLL_MS = 1_000;
const LOG_KEEP = 5_000;

/** The device's log lines while `open`, read every second from where the last read ended. */
export function useDeviceLogs(client: DeviceTabClient, panelId: string, open: boolean): { lines: DeviceLogLine[]; problem?: string } {
  const [lines, setLines] = useState<DeviceLogLine[]>([]);
  const [problem, setProblem] = useState<string>();
  const next = useRef(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: number | undefined;
    const read = async () => {
      const page = await client.logs(panelId, next.current).catch((cause: unknown) => ({ lines: [], next: next.current, problem: cause instanceof Error ? cause.message : 'Pane could not read the log.' }));
      if (cancelled) return;
      // A restarted log counts from a new start: lines already shown stay, and reading goes on from there.
      next.current = page.next;
      setProblem(page.problem);
      if (page.lines.length > 0) setLines(current => [...current, ...page.lines.filter(line => line.seq > (current.at(-1)?.seq ?? -1))].slice(-LOG_KEEP));
      timer = window.setTimeout(() => { void read(); }, LOG_POLL_MS);
    };
    void read();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, panelId, open]);
  return problem === undefined ? { lines } : { lines, problem };
}

/** The last capture, shown in a card beside the phone with what happened to it and Copy, Save and Mark up. */
export interface CaptureNotice {
  capture: DeviceCapture;
  name: string;
  /** What happened, such as "Added to chat". */
  title: string;
}

