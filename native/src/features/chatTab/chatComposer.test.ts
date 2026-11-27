import { describe, expect, it } from 'vitest';

import { CHAT_IMAGE_MAX_BYTES, chatImageProblem, chatSendRequest } from './chatComposer';

describe('chatImageProblem', () => {
  it('accepts the image types desktop accepts, up to 5 MiB', () => {
    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) expect(chatImageProblem({ mimeType, size: 10 })).toBeUndefined();
    expect(chatImageProblem({ mimeType: 'image/png', size: CHAT_IMAGE_MAX_BYTES })).toBeUndefined();
  });
  it('says what to choose instead', () => {
    expect(chatImageProblem({ mimeType: 'image/heic', size: 10 })).toBe('Choose a PNG, JPEG, WebP or GIF image.');
    expect(chatImageProblem({ mimeType: 'image/png', size: CHAT_IMAGE_MAX_BYTES + 1 })).toBe('Choose an image smaller than 5 MiB.');
  });
});

describe('chatSendRequest', () => {
  const image = { mimeType: 'image/png', data: 'AAAA' };
  it('sends text alone without an images field', () => {
    expect(chatSendRequest('op-1', 'hi', [])).toEqual({ operationId: 'op-1', text: 'hi' });
  });
  it('sends images as base64 + mimeType, like desktop', () => {
    expect(chatSendRequest('op-1', 'look', [image])).toEqual({ operationId: 'op-1', text: 'look', images: [image] });
  });
  it('sends an image-only prompt', () => {
    expect(chatSendRequest('op-1', '  ', [image])).toEqual({ operationId: 'op-1', text: '', images: [image] });
  });
  it('sends nothing when there is neither text nor an image', () => {
    expect(chatSendRequest('op-1', ' \n', [])).toBeUndefined();
  });
});
