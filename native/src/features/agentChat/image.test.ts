import { describe, expect, it } from 'vitest';

import { chatImage } from './image';

describe('Chat image content', () => {
  it('uses the exported image bytes rather than the original picker MIME type', () => {
    const jpeg = '/9j/4AAQSkZJRgABAQ==';
    const png = 'iVBORw0KGgoAAAANSUhEUg==';
    expect(chatImage(jpeg)).toEqual({ mimeType: 'image/jpeg', data: jpeg });
    expect(chatImage(png)).toEqual({ mimeType: 'image/png', data: png });
    expect(() => chatImage(btoa('not an image'))).toThrow('PNG, JPEG, WebP or GIF');
    expect(() => chatImage('/9j/' + 'A'.repeat(7 * 1024 * 1024))).toThrow('5 MiB');
  });
});
