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
      pairingListener: () => ({ port: 1 }),
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

  it('says why phones cannot connect while the pairing listener is down, and clears it once the listener is up', async () => {
    let listener: { port: number } | { error: string } = { error: 'listen EADDRINUSE: address already in use 127.0.0.1:42137' };
    let changed = () => {};
    const service = new RelayService({
      // Nothing listens on port 9, so the computer stays connecting.
      settings: () => ({ enabled: true, relayAddress: '127.0.0.1:9' }),
      onSettingsChanged: (onChange) => { changed = onChange; return () => {}; },
      secrets: { read: async () => null, write: async () => {} },
      dataDir: mkdtempSync(join(tmpdir(), 'pane-relay-service-')),
      pairingListener: () => listener,
      previewPort: () => null,
      displayName: () => 'Studio Mac',
      addClient: async () => {},
      env: {},
    });
    service.start();

    await vi.waitFor(() => expect(service.getStatus()).toMatchObject({
      phase: 'error',
      lastError: expect.stringMatching(/^Phones can't connect: this computer's phone listener isn't running \(listen EADDRINUSE.*Settings › Remote Access/u),
    }));
    expect(() => service.createPairingCode()).toThrow(/EADDRINUSE/u);

    listener = { port: 42137 };
    changed();
    await vi.waitFor(() => expect(service.getStatus().lastError ?? '').not.toMatch(/listener/u));
    await service.stop();
  });
});
