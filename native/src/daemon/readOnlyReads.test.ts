import { expect, it, vi } from 'vitest';

import { readOnlyToken } from '@shared/types/accessLevel';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { readUnlessRefused } from './readOnlyReads';

const mine: RemotePaneConnectionProfile = { id: 'mine', label: 'Mine', baseUrl: 'https://mine.runpane.net', token: 't', transport: 'http+sse' };
const tyler: RemotePaneConnectionProfile = { ...mine, id: 'tyler', token: readOnlyToken('a') };

it('never asks a read-only computer for its questions or permission requests, and lists none', async () => {
  const read = vi.fn(async () => { throw new Error('refused'); });
  expect(await readUnlessRefused(tyler, 'notify:remote-snapshot', read)).toMatchObject({ items: [], queue: [] });
  expect(await readUnlessRefused(tyler, 'permission:getPending', read)).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});

it('reads everything else there, and everything on a full-access computer', async () => {
  const read = async () => 'from the computer';
  expect(await readUnlessRefused(tyler, 'orchestration-sessions:list', read)).toBe('from the computer');
  expect(await readUnlessRefused(mine, 'notify:remote-snapshot', read)).toBe('from the computer');
});
