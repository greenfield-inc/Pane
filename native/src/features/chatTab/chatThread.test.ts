import { describe, expect, it } from 'vitest';

import { queuedLabel } from './chatComposer';
import { attachmentPreview, chatImageAdapter, chatImageAttachment, chatSendFromComposer, chatThreadMessage, composedText, restorableAttachments } from './chatThread';

const picked = { key: 'asset-1', uri: 'file:///photos/IMG_1.jpg', mimeType: 'image/jpeg', data: 'AAAA' };

/** What the composer hands onNew: its text, and its attachments as complete. */
function composed(text: string, images: typeof picked[] = []) {
  return {
    content: text ? [{ type: 'text' as const, text }] : [],
    attachments: images.map(image => ({ ...chatImageAttachment(image), id: image.key, type: 'image', status: { type: 'complete' as const }, content: chatImageAttachment(image).content })),
  };
}

describe('chatThreadMessage', () => {
  it('mirrors a host message part for part, under its host id', () => {
    const message = chatThreadMessage({ id: 'm1', role: 'assistant', parts: [
      { type: 'thought', text: 'Looking' },
      { type: 'text', text: 'Done.' },
      { type: 'tool', id: 't1', title: 'Run tests', status: 'in_progress' },
      { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'BBBB' } },
    ] });
    expect(message.id).toBe('m1');
    expect(message.role).toBe('assistant');
    expect(message.content).toEqual([
      { type: 'reasoning', text: 'Looking' },
      { type: 'text', text: 'Done.' },
      expect.objectContaining({ type: 'tool-call', toolCallId: 't1', toolName: 'Run tests', isPreliminary: true }),
      { type: 'image', image: 'data:image/png;base64,BBBB' },
    ]);
  });
});

describe('chatImageAttachment', () => {
  it('is a ready image attachment that carries the bytes as a data URL', () => {
    const attachment = chatImageAttachment(picked);
    expect(attachment).toEqual({ id: 'asset-1', type: 'image', name: 'IMG_1.jpg', contentType: 'image/jpeg', content: [{ type: 'image', image: 'data:image/jpeg;base64,AAAA' }] });
    expect(attachmentPreview(attachment)).toBe('data:image/jpeg;base64,AAAA');
  });
  it('is one of the types the runtime adapter accepts', () => {
    expect(chatImageAdapter.accept.split(',')).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  });
});

describe('chatSendFromComposer', () => {
  it('sends text alone as one host request with the given operation ID', () => {
    expect(chatSendFromComposer('op-1', composed('hello'))).toEqual({ operationId: 'op-1', text: 'hello' });
  });
  it('sends attached images as base64 + mimeType', () => {
    expect(chatSendFromComposer('op-2', composed('look', [picked, { ...picked, key: 'asset-2', mimeType: 'image/png', data: 'CCCC' }]))).toEqual({
      operationId: 'op-2', text: 'look', images: [{ mimeType: 'image/jpeg', data: 'AAAA' }, { mimeType: 'image/png', data: 'CCCC' }],
    });
  });
  it('sends an image-only message with empty text', () => {
    expect(chatSendFromComposer('op-3', composed('', [picked]))).toEqual({ operationId: 'op-3', text: '', images: [{ mimeType: 'image/jpeg', data: 'AAAA' }] });
  });
  it('sends nothing for blank text and no image', () => {
    expect(chatSendFromComposer('op-4', composed('  \n'))).toBeUndefined();
  });
  it('refuses an image it cannot read instead of sending without it', () => {
    const message = composed('look', [picked]);
    message.attachments[0].content = [{ type: 'image', image: 'file:///photos/IMG_1.heic' }];
    expect(() => chatSendFromComposer('op-5', message)).toThrow('An attached image could not be read. Remove it and attach it again.');
  });
});

describe('restorableAttachments', () => {
  it('gives back the sent images as they were, so the draft stays until the host confirms it', () => {
    const message = composed('look', [picked]);
    expect(composedText(message)).toBe('look');
    expect(restorableAttachments(message)).toEqual([chatImageAttachment(picked)]);
  });
});

describe('queuedLabel', () => {
  it('shows the text preview, or the images when there is no text', () => {
    expect(queuedLabel({ text: 'next step' })).toBe('next step');
    expect(queuedLabel({ text: '', imageCount: 3 })).toBe('3 images');
    expect(queuedLabel({ text: '', images: [{ mimeType: 'image/png', data: 'A' }] })).toBe('1 image');
  });
});
