import { describe, expect, it } from 'vitest';
import { formatBytes } from '../../../shared/utils/formatBytes';

describe('formatBytes', () => {
  it('reads whole GB from 10 GB, one decimal below, then MB, then KB', () => {
    expect(formatBytes(13.4 * 1024 ** 3)).toBe('13 GB');
    expect(formatBytes(2.44 * 1024 ** 3)).toBe('2.4 GB');
    expect(formatBytes(980 * 1024 ** 2)).toBe('980 MB');
    expect(formatBytes(900_000)).toBe('879 KB');
    expect(formatBytes(512)).toBe('1 KB');
  });
});
