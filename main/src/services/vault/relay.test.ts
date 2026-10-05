import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  decodePaneRemoteConnection,
  remoteImportPayloadToProfile,
  type RemoteDaemonConfig,
} from '../../../../shared/types/remoteDaemon';
import { RemotePaneClient } from '../../daemon/client/remotePaneClient';
import { PaneCommandRegistry } from '../../daemon/commandRegistry';
import { PaneRemoteHttpApiServer } from '../../daemon/httpApiServer';
import { setupRemoteHost } from '../../daemon/setupRemoteHost';
import {
  createDaemonTransportRelay,
  createSealedBundleReceiver,
  receiveSealedBundle,
  registerVaultTargetKeyCommand,
  VAULT_RECEIVE_SEALED_CHANNEL,
  type SealedBundleInbox,
  type SealedBundleRelay,
} from './relay';
import { sealBundle, type SealedBundle } from './sealedBundle';
import { loadOrCreateTargetKey } from './targetKey';

const CANARY = 'canary-sk-vault-v5-7c41d9';
const IN_AN_HOUR = () => new Date(Date.now() + 3_600_000).toISOString();

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempPaneDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-vault-relay-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Stands in for the #864 coordinator: stores serialized bundles per target and hands each target only its own. */
class FakeRelay implements SealedBundleRelay {
  private readonly stored = new Map<string, string[]>();

  async deliver(bundle: SealedBundle): Promise<void> {
    const queue = this.stored.get(bundle.header.recipient) ?? [];
    queue.push(JSON.stringify(bundle));
    this.stored.set(bundle.header.recipient, queue);
  }

  /** The caller binding: an inbox is opened for the authenticated target, never chosen by the request. */
  inboxFor(targetPublicKey: string): SealedBundleInbox {
    return {
      collect: async () => {
        const queue = this.stored.get(targetPublicKey) ?? [];
        this.stored.delete(targetPublicKey);
        return queue.map((serialized): SealedBundle => JSON.parse(serialized));
      },
    };
  }

  storedBytes(): string {
    return [...this.stored.values()].flat().join('\n');
  }
}

describe('fake store-and-forward relay (J4a)', () => {
  it('lets a target pull and open its bundle after the desktop is gone, while the relay holds only ciphertext', async () => {
    const targetDir = await tempPaneDir();
    const target = await loadOrCreateTargetKey(targetDir);
    const otherTarget = await loadOrCreateTargetKey(await tempPaneDir());
    const relay = new FakeRelay();

    // Desktop, with a standing approval: seals to the enrolled key and hands the bundle to the relay, then quits.
    await relay.deliver(await sealBundle(target.publicKey, Buffer.from(CANARY), { bundleId: 'b1', expiresAt: IN_AN_HOUR() }));
    expect(relay.storedBytes()).not.toBe('');
    expect(relay.storedBytes()).not.toContain(CANARY);
    expect(relay.storedBytes()).not.toContain(Buffer.from(CANARY).toString('base64url'));

    expect(await relay.inboxFor(otherTarget.publicKey).collect()).toEqual([]);

    const applied: string[] = [];
    for (const bundle of await relay.inboxFor(target.publicKey).collect()) {
      await receiveSealedBundle(targetDir, bundle, async (plaintext) => {
        applied.push(Buffer.from(plaintext).toString('utf8'));
      });
    }
    expect(applied).toEqual([CANARY]);
    expect(relay.storedBytes()).toBe('');
  });
});

describe('daemon transport relay', () => {
  it('enrolls the target key from a fresh connection code and delivers a bundle only that target can open', async () => {
    const targetDir = await tempPaneDir();
    let remoteDaemon: RemoteDaemonConfig | undefined;
    const setup = await setupRemoteHost({
      label: 'Agent box',
      paneDir: targetDir,
      preferTunnel: 'ssh',
      installService: false,
      autoSelectListenPort: true,
      existingConfig: { anthropicApiKey: undefined },
      writeConfig: async (config) => {
        remoteDaemon = config.remoteDaemon;
      },
    });
    if (!remoteDaemon) throw new Error('Expected setup to write the host config');
    const hostConfig = remoteDaemon;

    const applied: string[] = [];
    const registry = new PaneCommandRegistry();
    registerVaultTargetKeyCommand(registry, targetDir);
    registry.register(VAULT_RECEIVE_SEALED_CHANNEL, createSealedBundleReceiver(targetDir, async (plaintext) => {
      applied.push(Buffer.from(plaintext).toString('utf8'));
    }));
    const server = new PaneRemoteHttpApiServer(registry, { getConfig: () => ({ remoteDaemon: hostConfig }) });
    await server.start();
    cleanups.push(() => server.stop());

    // Desktop: imports the code; the saved profile carries the enrolled key.
    const profile = remoteImportPayloadToProfile(decodePaneRemoteConnection(setup.connectionCode));
    const vaultKey = profile.vaultKey;
    if (!vaultKey) throw new Error('Expected the connection code to carry a vault key');
    const client = new RemotePaneClient(profile);
    await client.connect();
    cleanups.push(() => client.disconnect());
    await expect(client.invoke('vault:target-key', [])).resolves.toBe(vaultKey);

    const relay = createDaemonTransportRelay((channel, args) => client.invoke(channel, args));
    await relay.deliver(await sealBundle(vaultKey, Buffer.from(CANARY), { bundleId: 'b1', expiresAt: IN_AN_HOUR() }));
    expect(applied).toEqual([CANARY]);

    const strangerKey = (await loadOrCreateTargetKey(await tempPaneDir())).publicKey;
    const misaddressed = await sealBundle(strangerKey, Buffer.from(CANARY), { bundleId: 'b2', expiresAt: IN_AN_HOUR() });
    await expect(relay.deliver(misaddressed)).rejects.toThrow(/another target/);
    expect(applied).toEqual([CANARY]);
  });
});
