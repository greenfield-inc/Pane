import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RelayService } from './relayService';

afterEach(() => { vi.useRealTimers(); });

describe('relay service', () => {
  it('starts phone access again after it failed at launch, as with a locked keychain', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    let locked = true;
    const service = new RelayService({
      // Nothing listens on port 9, so the computer stays connecting; the key is what this checks.
      settings: () => ({ enabled: true, relayAddress: '127.0.0.1:9' }),
      onSettingsChanged: () => () => {},
      secrets: {
        read: async () => {
          if (locked) throw new Error('The keychain is locked.');
          return null;
        },
        write: async () => {},
      },
      dataDir: mkdtempSync(join(tmpdir(), 'pane-relay-service-')),
      serverPort: () => null,
      previewPort: () => null,
      displayName: () => 'Studio Mac',
      addClient: async () => {},
      env: {},
    });
    service.start();
    await vi.waitFor(() => expect(service.getStatus()).toMatchObject({ phase: 'error', lastError: 'The keychain is locked.', id: null }));

    locked = false;
    await vi.advanceTimersByTimeAsync(5_000);

    await vi.waitFor(() => expect(service.getStatus().id).toMatch(/^[a-z0-9]{16}$/u));
    await service.stop();
  });
});
