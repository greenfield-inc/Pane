import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../commandRegistry';
import { registerRelayCommands } from './relayCommands';
import type { RelayService } from './relayService';
import { RelayPreviews } from './relayPreviews';
import type { RelayLinks } from './relayLinks';
import type { ComputerLinking } from './computerLinking';
import type { RelayComputer, RelayStatus } from '../../../../shared/types/relay';

const LISTENER_STARTING = "Phones can't connect: this computer's phone listener isn't running (it is still starting). In Settings › Remote Access › Tailscale › Advanced, turn on the host listener or give it a free port.";
const computer: RelayComputer = { id: 'k7xq2m4n8p3r5t6v', name: 'Mac', address: 'https://k7xq2m4n8p3r5t6v.runpane.net', domain: 'runpane.net', fingerprint: 'fp', local: [] };

/** A computer with phone access off: `runpane link` turns it on, and the relay reports each phase it goes through. */
function headless(phases: Array<Pick<RelayStatus, 'phase' | 'lastError'>>) {
  let enabled = false;
  let ticks = 0;
  let last: RelayStatus['phase'] = 'off';
  const status = (): RelayStatus => {
    const current = enabled ? phases[Math.min(ticks++, phases.length - 1)] : { phase: 'off' as const, lastError: null };
    last = current.phase;
    return { enabled, id: null, domain: null, address: null, relay: null, region: null, localAddresses: [], certificate: null, ...current };
  };
  const relay: Pick<RelayService, 'getStatus' | 'createPairingCode' | 'computerInfo'> = {
    getStatus: status,
    createPairingCode: () => { throw new Error('not used'); },
    computerInfo: () => (last === 'ready' ? computer : undefined),
  };
  const redeem = vi.fn(async () => ({ linked: ['Mac'] }));
  const linking = { redeem, preview: vi.fn() };
  const registry = new PaneCommandRegistry();
  registerRelayCommands(
    registry,
    relay,
    new RelayPreviews({ id: () => null, domain: () => null, isForwardedPort: () => false, clientActive: () => false }),
    // SAFETY: redeeming a link reaches only the relay, linking.redeem and the config, never RelayLinks.
    {} as RelayLinks,
    // SAFETY: redemption calls only redeem, which this fake provides.
    linking as ComputerLinking,
    { updateConfigWith: async () => { enabled = true; return {}; } },
  );
  return { redeem, run: () => registry.invoke('relay:redeem-link', [{ link: 'https://runpane.net/pair#s=x' }]) };
}

describe('redeeming a link on a computer with phone access off', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('waits while the phone listener is still starting, then uses the link', async () => {
    const computer = headless([
      { phase: 'error', lastError: LISTENER_STARTING },
      { phase: 'error', lastError: LISTENER_STARTING },
      { phase: 'connecting', lastError: null },
      { phase: 'ready', lastError: null },
    ]);
    const result = computer.run();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toEqual({ linked: ['Mac'] });
    expect(computer.redeem).toHaveBeenCalledOnce();
  });

  it('gives up on an error that does not clear, naming it in one sentence', async () => {
    const computer = headless([{ phase: 'error', lastError: "Can't reach relay.runpane.net: ENOTFOUND." }]);
    const result = computer.run();
    const failed = expect(result).rejects.toMatchObject({
      code: 'ERR_RELAY_NOT_READY',
      message: "Phone access did not get ready on this computer, so the link was not used: Can't reach relay.runpane.net: ENOTFOUND.",
    });
    await vi.advanceTimersByTimeAsync(130_000);
    await failed;
    expect(computer.redeem).not.toHaveBeenCalled();
  });
});
