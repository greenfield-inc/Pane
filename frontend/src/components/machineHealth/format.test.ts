import { describe, expect, it } from 'vitest';
import { formatBytes } from './format';

describe('formatBytes', () => {
  it('reads like the Resources page: whole GB from 10 GB, one decimal below, then MB', () => {
    expect(formatBytes(13.4 * 1024 ** 3)).toBe('13 GB');
    expect(formatBytes(2.44 * 1024 ** 3)).toBe('2.4 GB');
    expect(formatBytes(980 * 1024 ** 2)).toBe('980 MB');
    expect(formatBytes(512)).toBe('1 KB');
  });
});
