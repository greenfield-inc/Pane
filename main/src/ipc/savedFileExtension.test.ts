import { describe, expect, it } from 'vitest';
import { savedFileExtension } from './savedFileExtension';

describe('savedFileExtension', () => {
  it('keeps a pasted or dropped file’s own extension (round 7 QA, R14)', () => {
    expect(savedFileExtension('notes.txt', 'text/plain')).toBe('txt');
    expect(savedFileExtension('Receipt Mock-up.SVG', 'image/svg+xml')).toBe('svg');
  });

  it('falls back to the type for an unnamed image, as a pasted screenshot is', () => {
    expect(savedFileExtension('', 'image/png')).toBe('png');
    expect(savedFileExtension('image', 'image/jpeg')).toBe('jpeg');
    expect(savedFileExtension('', '')).toBe('png');
  });

  it('never takes path parts or odd characters from the name', () => {
    expect(savedFileExtension('../../evil.sh/..', 'text/plain')).toBe('plain');
    expect(savedFileExtension('a.t x t', 'text/plain')).toBe('plain');
  });
});
