import type { PaneCommandHandler, PaneCommandRegistry, PaneCommandValue } from '../../daemon/commandRegistry';
import { decodeSealedBundle, openSealedBundle, type SealedBundle } from './sealedBundle';
import { loadOrCreateTargetKey } from './targetKey';

const VAULT_TARGET_KEY_CHANNEL = 'vault:target-key';
export const VAULT_RECEIVE_SEALED_CHANNEL = 'vault:receive-sealed';

/**
 * Desktop side: carries a sealed bundle to the target named in its header.
 * A relay sees only ciphertext and the authenticated header.
 */
export interface SealedBundleRelay {
  deliver(bundle: SealedBundle): Promise<void>;
}

/**
 * Target side of a store-and-forward relay (the #864 coordinator, or a fake in tests).
 * The relay binds the caller to its target, so collect() returns only bundles sealed for this machine and removes them.
 */
export interface SealedBundleInbox {
  collect(): Promise<SealedBundle[]>;
}

/** Hands an opened bundle's plaintext to the target's writer (V4). */
export type ApplyVaultBundle = (plaintext: Uint8Array, bundle: SealedBundle) => Promise<void>;

type InvokeDaemonCommand = (channel: string, args: PaneCommandValue[]) => Promise<PaneCommandValue>;

/** Laptop open: pushes the bundle straight to the target over the authenticated daemon transport. */
export function createDaemonTransportRelay(invoke: InvokeDaemonCommand): SealedBundleRelay {
  return {
    async deliver(bundle) {
      await invoke(VAULT_RECEIVE_SEALED_CHANNEL, [bundle]);
    },
  };
}

/** Opens a bundle with this machine's target key and applies it. Throws, applying nothing, if it is not ours or has expired. */
export async function receiveSealedBundle(paneDir: string, bundle: SealedBundle, apply: ApplyVaultBundle): Promise<void> {
  const plaintext = await openSealedBundle(await loadOrCreateTargetKey(paneDir), bundle);
  await apply(plaintext, bundle);
}

/** Lets a paired desktop enroll this machine's key when its connection code predates vault keys. */
export function registerVaultTargetKeyCommand(registry: PaneCommandRegistry, paneDir: string): void {
  registry.register(VAULT_TARGET_KEY_CHANNEL, async () => (await loadOrCreateTargetKey(paneDir)).publicKey);
}

/** The handler for VAULT_RECEIVE_SEALED_CHANNEL, registered by whoever owns `apply`. */
export function createSealedBundleReceiver(paneDir: string, apply: ApplyVaultBundle): PaneCommandHandler<[PaneCommandValue], null> {
  return async (value) => {
    await receiveSealedBundle(paneDir, decodeSealedBundle(value), apply);
    return null;
  };
}
