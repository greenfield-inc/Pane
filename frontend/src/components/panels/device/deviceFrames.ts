import { useEffect, useState } from 'react';
import type { DeviceTabClient } from './deviceClient';

/** Frames over a connection: about twice a second (phones, the browser app, a remote desktop). */
export const FRAME_POLL_MS = 500;

/** The device's latest frame as a data URL, read every `everyMs` while the page is visible; off when undefined. */
export function useDeviceFrames(client: DeviceTabClient, panelId: string, everyMs: number | undefined): string | undefined {
  const [frame, setFrame] = useState<string>();
  useEffect(() => {
    if (everyMs === undefined) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        const next = await client.frame(panelId).catch(() => undefined);
        if (cancelled) return;
        if (next) setFrame(next);
      }
      timer = window.setTimeout(() => { void tick(); }, everyMs);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, panelId, everyMs]);
  return frame;
}

/** A JPEG data URL as a PNG blob, for the clipboard. */
export async function jpegToPng(dataUrl: string): Promise<Blob> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('The screen could not be encoded'))), 'image/png'));
}
