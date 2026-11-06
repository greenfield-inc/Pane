import { describe, expect, it, vi } from 'vitest';
import type { PendingAttachment } from '@assistant-ui/react';
import { ChatAttachmentAdapter, dragHasFiles, MAX_FILE_BYTES, MAX_IMAGE_BYTES } from './chatAttachments';

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
    const saveFile = vi.fn(async ({ name }: { name: string }) => `/repo/.pane/files/${name}`);
    const copying: number[] = [];
    const adapter = new ChatAttachmentAdapter({ images: true, saveFile, readDataUrl, onCopying: delta => copying.push(delta) });
    const states = await attach(adapter, file('notes.pdf', 'application/pdf'));
    expect(states.map(state => state.status.type)).toEqual(['running', 'requires-action']);
    expect(saveFile).toHaveBeenCalledWith({ name: 'notes.pdf', dataUrl: 'data:application/pdf;base64,AAAA' });
    expect((await adapter.send(states[1])).content).toEqual([{ type: 'text', text: '/repo/.pane/files/notes.pdf' }]);
    expect(copying).toEqual([1, -1]);
  });

  it('copies an image the agent cannot take as an image (too large, HEIC, or no image support)', async () => {
    const saveFile = vi.fn(async ({ name }: { name: string }) => `/files/${name}`);
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
    const withFiles = new ChatAttachmentAdapter({ images: true, saveFile: async () => '/x', readDataUrl });
    await expect(attach(withFiles, file('movie.mov', 'video/quicktime', MAX_FILE_BYTES + 1))).rejects.toThrow('movie.mov was not attached: it is larger than 10 MB');
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
