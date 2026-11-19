// The frame scaler's page (frameScaler.ts): decodes a frame, draws it smaller and answers it as a
// JPEG data URL, in this sandboxed renderer rather than Pane's main process.
import { ipcRenderer } from 'electron';

interface ScaleJob { id: number; bytes: Uint8Array; maxPx: number; quality: number }

let canvas: HTMLCanvasElement | undefined;

ipcRenderer.on('frame-scaler:scale', (_event, job: ScaleJob) => {
  void (async () => {
    try {
      const image = await createImageBitmap(new Blob([job.bytes]));
      const scale = job.maxPx / Math.max(image.width, image.height);
      if (scale >= 1) {
        image.close();
        ipcRenderer.send('frame-scaler:scaled', { id: job.id, url: null });
        return;
      }
      canvas ??= document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2D canvas');
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      image.close();
      // toDataURL encodes at once; a hidden page's convertToBlob waits about a second.
      ipcRenderer.send('frame-scaler:scaled', { id: job.id, url: canvas.toDataURL('image/jpeg', job.quality) });
    } catch (cause) {
      ipcRenderer.send('frame-scaler:scaled', { id: job.id, error: cause instanceof Error ? cause.message : String(cause) });
    }
  })();
});
