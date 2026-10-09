import { open } from 'fs/promises';
import { extname } from 'path';
import { Readable } from 'stream';

const MIME_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'], ['.webp', 'image/webp'], ['.avif', 'image/avif'],
  ['.gif', 'image/gif'], ['.ico', 'image/x-icon'], ['.bmp', 'image/bmp'],
  ['.pdf', 'application/pdf'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
  ['.html', 'text/html'], ['.htm', 'text/html'],

  ['.mp4', 'video/mp4'], ['.m4v', 'video/mp4'], ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'], ['.mkv', 'video/x-matroska'], ['.ogg', 'video/ogg'], ['.ogv', 'video/ogg'],
  ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'], ['.flac', 'audio/flac'], ['.oga', 'audio/ogg'], ['.opus', 'audio/ogg'],
]);

/** Serve only the requested bytes; Chromium's file fetch omits Content-Range. */
export async function streamMediaFile(filePath: string, request: Request): Promise<Response> {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Not a regular file');
    const size = stat.size;
    const headers = new Headers({
      'Content-Type': MIME_TYPES.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length',
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
    });
    let start = 0;
    let end = size - 1;
    const range = request.headers.get('Range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      }
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        await file.close();
        headers.set('Content-Range', `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    headers.set('Content-Length', String(Math.max(0, end - start + 1)));
    const status = range ? 206 : 200;
    if (request.method === 'HEAD' || size === 0) {
      await file.close();
      return new Response(null, { status, headers });
    }
    const stream = file.createReadStream({ start, end, autoClose: true });
    const abort = () => stream.destroy();
    request.signal.addEventListener('abort', abort, { once: true });
    stream.once('close', () => request.signal.removeEventListener('abort', abort));
    if (request.signal.aborted) stream.destroy();
    // SAFETY: Node's toWeb adapter produces a byte stream from this file handle.
    return new Response(Readable.toWeb(stream, {
      strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
    }) as ReadableStream<Uint8Array>, { status, headers });
  } catch (error) {
    await file.close();
    throw error;
  }
}
