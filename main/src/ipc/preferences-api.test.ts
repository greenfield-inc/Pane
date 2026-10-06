import { describe, expect, it } from 'vitest';
import { createPreferencesApi } from '../../../shared/types/preferences';

describe('preload preferences API', () => {
  it('preserves missing and empty values without conflating them with a failed read', async () => {
    const preferences = createPreferencesApi(async (_channel, key) => ({ success: true, data: key === 'missing' ? null : '' }));
    await expect(preferences.get('missing')).resolves.toBeNull();
    await expect(preferences.get('empty')).resolves.toBe('');
  });

  it('returns all string preferences and sends the exact persisted value', async () => {
    const writes: unknown[][] = [];
    const preferences = createPreferencesApi(async (channel, ...args) => {
      if (channel === 'preferences:get-all') return { success: true, data: { theme: 'dark', hidden: 'false' } };
      writes.push([channel, ...args]);
      return { success: true };
    });
    await expect(preferences.getAll()).resolves.toEqual({ theme: 'dark', hidden: 'false' });
    await expect(preferences.set('hidden', 'false')).resolves.toBeUndefined();
    expect(writes).toEqual([['preferences:set', 'hidden', 'false']]);
  });

  it('rejects failed writes and reads with the host reason', async () => {
    const preferences = createPreferencesApi(async () => ({ success: false, error: 'Preferences database is unavailable' }));
    await expect(preferences.get('theme')).rejects.toThrow('Preferences database is unavailable');
    await expect(preferences.getAll()).rejects.toThrow('Preferences database is unavailable');
    await expect(preferences.set('theme', 'dark')).rejects.toThrow('Preferences database is unavailable');
  });

  it('rejects malformed success payloads before they reach settings callers', async () => {
    await expect(createPreferencesApi(async () => ({ success: true, data: 42 })).get('theme')).rejects.toThrow();
    await expect(createPreferencesApi(async () => ({ success: true, data: { theme: false } })).getAll()).rejects.toThrow();
    await expect(createPreferencesApi(async () => ({ success: 'true' })).set('theme', 'dark')).rejects.toThrow();
    await expect(createPreferencesApi(async () => ({ success: true })).get('theme')).rejects.toThrow();
  });
});
