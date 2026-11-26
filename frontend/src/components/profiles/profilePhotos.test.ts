import { describe, expect, it } from 'vitest';
import { MAX_PROFILE_PHOTO_BYTES } from '../../../../shared/types/profileEditor';
import { PHOTO_ACCEPT, PHOTO_SAMPLES, svgPhotoProblem } from './profilePhotos';

describe('profile photos (T-83: SVG only)', () => {
  it('accepts an SVG by its type or its extension', () => {
    expect(PHOTO_ACCEPT).toBe('.svg,image/svg+xml');
    expect(svgPhotoProblem({ name: 'me.svg', type: '', size: 100 })).toBeNull();
    expect(svgPhotoProblem({ name: 'me', type: 'image/svg+xml', size: 100 })).toBeNull();
    expect(svgPhotoProblem({ name: 'ME.SVG', type: '', size: MAX_PROFILE_PHOTO_BYTES })).toBeNull();
  });

  it('refuses another kind of picture, and an SVG over 64 KiB, before reading it', () => {
    expect(svgPhotoProblem({ name: 'me.png', type: 'image/png', size: 100 })).toMatch(/isn't an SVG/);
    expect(svgPhotoProblem({ name: 'big.svg', type: 'image/svg+xml', size: MAX_PROFILE_PHOTO_BYTES + 1 })).toBe(
      'big.svg is 65 KiB; a profile photo is at most 64 KiB. Choose a smaller SVG, or simplify this one.',
    );
  });

  it('sends each sample as SVG text that shows as the same picture', () => {
    for (const sample of PHOTO_SAMPLES) {
      expect(sample.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64">/);
      expect(sample.svg).not.toMatch(/<script|href=|<image|foreignObject/i);
      expect(new TextEncoder().encode(sample.svg).length).toBeLessThanOrEqual(MAX_PROFILE_PHOTO_BYTES);
      expect(decodeURIComponent(sample.src.replace('data:image/svg+xml;utf8,', ''))).toBe(sample.svg);
    }
  });
});
