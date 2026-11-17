import { describe, expect, it, vi } from 'vitest';
import type { PendingAttachment } from '@assistant-ui/react';
import type { UploadProgress } from '../../../../shared/chunkedUpload';
import { ChatAttachmentAdapter, dragHasFiles, MAX_IMAGE_BYTES } from './chatAttachments';

const file = (name: string, type: string, size = 10) => new File([new Uint8Array(size)], name, { type });
const readDataUrl = async (input: File) => `data:${input.type || 'application/octet-stream'};base64,AAAA`;

async function attach(adapter: ChatAttachmentAdapter, input: File): Promise<PendingAttachment[]> {
  const states: PendingAttachment[] = [];
  for await (const state of adapter.add({ file: input })) states.push(state);
  return states;
}

describe('chat attachments (D-139)', () => {
  it('attaches an image the agent takes as an image, sent as its data URL', async () => {
    const adapter = new ChatAttachmentAdapter({ images: true, readDataUrl });
    const [image] = await attach(adapter, file('shot.png', 'image/png'));
    expect(image).toMatchObject({ type: 'image', name: 'shot.png', status: { type: 'requires-action' } });
    expect((await adapter.send(image)).content).toEqual([{ type: 'image', image: 'data:image/png;base64,AAAA' }]);
  });

  it('copies any other file to the chat\'s machine first, then sends its path', async () => {
    const saveFile = vi.fn(async ({ name }: File, onProgress: (progress: UploadProgress) => void) => {
      onProgress({ receivedBytes: 5, totalBytes: 10, retrying: false, lastProgressAt: 0, secondsLeft: 30 });
      return `/repo/.pane/files/${name}`;
    });
    const progress: Array<number | null> = [];
    const adapter = new ChatAttachmentAdapter({ images: true, saveFile, readDataUrl, onProgress: (_id, update) => progress.push(update?.receivedBytes ?? null) });
    const states = await attach(adapter, file('notes.pdf', 'application/pdf'));
    expect(states.map(state => state.status.type)).toEqual(['running', 'requires-action']);
    expect(saveFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'notes.pdf' }), expect.any(Function), expect.any(AbortSignal));
    expect((await adapter.send(states[1])).content).toEqual([{ type: 'text', text: '/repo/.pane/files/notes.pdf' }]);
    // Started, half way, then done: the composer waits until the last.
    expect(progress).toEqual([0, 5, null]);
  });

  it('stops the copy when its chip is removed, which frees Send', async () => {
    let signal: AbortSignal | undefined;
    // A copy that would run until the host answers, which it doesn't.
    const saveFile = vi.fn((_file: File, _onProgress: (progress: UploadProgress) => void, abort: AbortSignal) => {
      signal = abort;
      return new Promise<string>(() => undefined);
    });
    const progress: Array<number | null> = [];
    const adapter = new ChatAttachmentAdapter({ images: true, saveFile, readDataUrl, onProgress: (_id, update) => progress.push(update?.receivedBytes ?? null) });
    const adding = adapter.add({ file: file('video.mov', 'video/quicktime') });
    // SAFETY: add yields the pending chip first, before its copy starts.
    const pending = (await adding.next()).value as PendingAttachment;
    const rest = adding.next();
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalled());

    await adapter.remove(pending);

    expect(await rest).toEqual({ done: true, value: undefined });
    expect(signal?.aborted).toBe(true);
    expect(progress.at(-1)).toBeNull();
  });

  it('picks up a copy still running when the draft comes back, instead of copying again', async () => {
    let finish: (path: string) => void = () => undefined;
    const saveFile = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const video = file('video.mov', 'video/quicktime');
    const left = new ChatAttachmentAdapter({ images: true, saveFile, readDataUrl });
    void attach(left, video).catch(() => undefined);
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));

    // The chat was left and opened again: its draft adds the same file to a new composer.
    const back = attach(new ChatAttachmentAdapter({ images: true, saveFile, readDataUrl }), video);
    finish('/files/video.mov');

    expect((await back).at(-1)).toMatchObject({ content: [{ type: 'text', text: '/files/video.mov' }] });
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it('copies an image the agent cannot take as an image (too large, HEIC, or no image support)', async () => {
    const saveFile = vi.fn(async ({ name }: File) => `/files/${name}`);
    for (const [options, input] of [
      [{ images: true }, file('big.png', 'image/png', MAX_IMAGE_BYTES + 1)],
      [{ images: true }, file('photo.heic', 'image/heic')],
      [{ images: false }, file('shot.png', 'image/png')],
    ] as const) {
      const states = await attach(new ChatAttachmentAdapter({ ...options, saveFile, readDataUrl }), input);
      expect(states.at(-1)).toMatchObject({ type: 'file', content: [{ type: 'text', text: `/files/${input.name}` }] });
    }
  });

  it('refuses with a reason it shows, attaching nothing', async () => {
    const imagesOnly = new ChatAttachmentAdapter({ images: true, readDataUrl });
    await expect(attach(imagesOnly, file('notes.pdf', 'application/pdf'))).rejects.toThrow('notes.pdf was not attached: this chat takes PNG, JPEG, WebP or GIF images here');
    await expect(attach(imagesOnly, file('big.png', 'image/png', MAX_IMAGE_BYTES + 1))).rejects.toThrow('larger than 5 MB');
    const failing = new ChatAttachmentAdapter({ images: false, saveFile: async () => { throw new Error('the host is offline'); }, readDataUrl });
    await expect(attach(failing, file('a.txt', 'text/plain'))).rejects.toThrow('a.txt was not attached: it could not be copied to the chat\'s machine (the host is offline).');
  });

  it('lets every file reach its own check, and knows when nothing can be attached', () => {
    expect(new ChatAttachmentAdapter({ images: true }).accept).toBe('*');
    expect(ChatAttachmentAdapter.available({ images: false })).toBe(false);
    expect(dragHasFiles(['text/plain', 'Files'])).toBe(true);
    expect(dragHasFiles(['text/plain'])).toBe(false);
  });
});
