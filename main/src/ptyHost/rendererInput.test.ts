import { expect, it, vi } from 'vitest';
import { PtyHostSupervisor } from './ptyHostSupervisor';

it('fences data-port writes before the PTY RPC while still allowing acknowledgements', () => {
  let frozen = false;
  const input = vi.fn(() => { if (frozen) throw new Error('Conversation is switching'); });
  const supervisor = new PtyHostSupervisor(input);
  const write = vi.spyOn(supervisor, 'write').mockResolvedValue();
  const ack = vi.spyOn(supervisor, 'ack').mockResolvedValue();
  // SAFETY: Exercise the exact decoded renderer boundary without opening Electron ports.
  const receive = supervisor['onRendererMessage'].bind(supervisor);
  receive(1, { type: 'write', ptyId: 'native-owner', data: 'first' });
  frozen = true;
  receive(1, { type: 'write', ptyId: 'native-owner', data: 'stale' });
  receive(1, { type: 'ack', ptyId: 'native-owner', bytes: 10 });
  expect(write.mock.calls).toEqual([['native-owner', 'first']]);
  expect(input).toHaveBeenCalledTimes(2);
  expect(ack).toHaveBeenCalledWith('native-owner', 10);
});
