import { describe, expect, it } from 'vitest';
import { htmlFileOpenModeOf } from './configStore';

describe('htmlFileOpenModeOf', () => {
  it('opens the browser preview when the setting is absent or the config has not loaded', () => {
    expect(htmlFileOpenModeOf(null)).toBe('preview');
    expect(htmlFileOpenModeOf({})).toBe('preview');
  });

  it('returns the saved choice', () => {
    expect(htmlFileOpenModeOf({ htmlFileOpenMode: 'source' })).toBe('source');
    expect(htmlFileOpenModeOf({ htmlFileOpenMode: 'preview' })).toBe('preview');
  });
});
