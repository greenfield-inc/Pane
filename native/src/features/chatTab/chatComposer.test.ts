import { describe, expect, it } from 'vitest';

import { CHAT_IMAGE_MAX_BYTES, chatImageProblem, chatSendRequest, matchingCommands } from './chatComposer';

const commands = [
  { name: 'review', description: 'Review the diff' },
  { name: 'compact' },
  { name: 'init', description: 'Write AGENTS.md' },
  { name: 'preview' },
];

describe('matchingCommands', () => {
  it('lists every command for a bare slash, by name', () => {
    expect(matchingCommands('/', commands).map(command => command.name)).toEqual(['compact', 'init', 'preview', 'review']);
  });
  it('filters as you type, prefix matches first', () => {
    expect(matchingCommands('/rev', commands).map(command => command.name)).toEqual(['review', 'preview']);
    expect(matchingCommands('/REV', commands).map(command => command.name)).toEqual(['review', 'preview']);
  });
  it('closes once the draft is more than a command name', () => {
    expect(matchingCommands('/review ', commands)).toEqual([]);
    expect(matchingCommands('hello /rev', commands)).toEqual([]);
    expect(matchingCommands('', commands)).toEqual([]);
  });
  it('shows at most 12', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ name: `c${String(index).padStart(2, '0')}` }));
    expect(matchingCommands('/', many)).toHaveLength(12);
  });
});

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
