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
  const time = new Date().toTimeString().slice(0, 8).replace(/:/g, '.');
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

/**
 * The tab's recording as its state carries it (so every client shows the same one): whether one
 * runs and the seconds since it started, ticking each second; Start and Stop.
 */
export function useRecording(client: DeviceTabClient, panelId: string, startedAt: number | undefined) {
  const [elapsed, setElapsed] = useState(0);
  // The host's clock started it, and another computer's clock can be seconds apart: a tab that
  // pressed Record counts from its own click; one that opens mid-recording counts from the host's start.
  // A host from before the tab's state carried recordings never sets `startedAt`: this tab's own
  // Start and Stop then say whether it records.
  const [clicked, setClicked] = useState<number>();
  const recording = startedAt !== undefined || clicked !== undefined;
  const from = clicked ?? startedAt;
  useEffect(() => {
    if (from === undefined) return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - from) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [from]);
  // A recording that ended on the host (its limit, an agent, the device) ends here too.
  const [previousStart, setPreviousStart] = useState(startedAt);
  if (startedAt !== previousStart) {
    setPreviousStart(startedAt);
    if (startedAt === undefined) setClicked(undefined);
  }
  const start = useCallback(async () => {
    const at = Date.now();
    await client.record(panelId, 'start');
    setClicked(at);
  }, [client, panelId]);
  const stop = useCallback(async (): Promise<DeviceRecording> => {
    try {
      const saved = await client.record(panelId, 'stop');
      if (!saved) throw new Error('The recording did not save.');
      return saved;
    } finally {
      setClicked(undefined);
    }
  }, [client, panelId]);
  return { recording, elapsed: recording ? elapsed : 0, start, stop };
}

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

