import { beforeEach, expect, it, vi } from 'vitest';

import { readOnlyToken } from '@shared/types/accessLevel';

const state = vi.hoisted(() => ({
  profiles: [] as object[],
  preview: {} as object,
  exchanged: [] as { known: string[] }[],
  answerAlert: 0,
  alerts: [] as string[],
  token: '',
  previews: 0,
  linked: 0,
  added: [] as { token: string }[],
}));
const FINGERPRINT = '8J58cPYzLPfxq98gpeqRTxP3zkp1kARV_p2rKUkdeTM';
const ID = '6cphy4hwgmwpp4nl';

vi.mock('@tanstack/react-query', () => ({ useMutation: (options: object) => options }));
vi.mock('expo-haptics', () => ({}));
vi.mock('react-native', () => ({
  Alert: { alert: (title: string, _message: string, buttons: { onPress(): void }[]) => { state.alerts.push(title); buttons[state.answerAlert].onPress(); } },
}));
vi.mock('@/auth/hostsStore', () => {
  const store = { add: async () => undefined, addMany: async (_linked: object[], paired: { token: string }) => { state.added.push(paired); }, get profiles() { return state.profiles; } };
  return { useHostsStore: Object.assign((select: (value: typeof store) => unknown) => select(store), { getState: () => store }) };
});
vi.mock('@/auth/pairing', () => ({}));
vi.mock('@/daemon/createClient', () => ({
  CLIENT_LABEL: 'Pane', DEVICE_LABEL: 'Phone', getRuntimeId: async () => 'phone',
  createDaemonClient: () => ({ invoke: async () => { state.linked += 1; return { token: 'minted' }; } }),
  streamingFetch: async (url: string, init: { body: string }) => {
    if (url.endsWith('/pair/preview')) {
      state.previews += 1;
      return Response.json(state.preview);
    }
    state.exchanged.push(JSON.parse(init.body));
    return Response.json({
      ok: true, token: state.token, clientId: 'c', linked: [],
      computer: { id: ID, name: 'Tyler', domain: 'runpane.net', address: `https://${ID}.runpane.net`, local: [], fingerprint: FINGERPRINT },
    });
  },
}));

const { usePairing } = await import('./usePairing');
// SAFETY: the mocked useMutation above returns its options, so mutationFn is the hook's own.
const pair = (input: { code: string; preview?: object | null }) => (usePairing() as unknown as { mutationFn(input: object): Promise<object> }).mutationFn(input);

const code = `https://runpane.net/pair#s=secret&c=${ID}&n=Tyler`;
const saved = (id: string, access?: 'read') => ({ id: `relay:${id}`, label: id, baseUrl: `https://${id}.runpane.net`, token: access ? readOnlyToken(id) : `t-${id}`, relay: { computerId: id } });

beforeEach(() => Object.assign(state, {
  profiles: [], exchanged: [], alerts: [], added: [], answerAlert: 1, previews: 0, linked: 0, token: readOnlyToken('tyler'),
  preview: { ok: true, access: 'read', group: [{ id: ID, name: 'Tyler' }, { id: 'tyler2', name: 'Tyler 2' }] },
}));

it('refuses a Read only code for a computer it has full access to, without spending it', async () => {
  state.profiles = [saved(ID)];
  await expect(pair({ code })).rejects.toThrow(`This phone already has full access to ${ID}`);
  expect(state.exchanged).toEqual([]);
});

it('saves nothing when the computer hid that its code is Read only', async () => {
  state.profiles = [saved(ID)];
  state.preview = { ok: true, group: [{ id: ID, name: 'Tyler' }] };
  await expect(pair({ code })).rejects.toThrow('already has full access');
  expect(state.added).toEqual([]);
});

it('tells a Read only code’s computer of none of this phone’s others', async () => {
  state.profiles = [saved('mine'), saved('tyler2', 'read')];
  await pair({ code, preview: state.preview });
  expect(state.exchanged.map(request => request.known)).toEqual([[]]);
});

it('refuses a Read only code while it still has full access to a computer the code shares, without spending it', async () => {
  // Full access removed everywhere, then shared read-only: that computer's full token is dead, and it would hand out no read-only one.
  state.profiles = [saved('tyler2')];
  await expect(pair({ code, preview: state.preview })).rejects.toThrow('This phone already has full access to tyler2');
  expect(state.exchanged).toEqual([]);
});

it('asks before spending a scanned Read only code, and once only', async () => {
  state.answerAlert = 0;
  await expect(pair({ code })).rejects.toThrow('Not paired');
  expect(state.exchanged).toEqual([]);

  state.answerAlert = 1;
  await pair({ code });
  expect(state.alerts).toEqual(['Watch Tyler', 'Watch Tyler']);
  expect(state.added.map(profile => profile.token)).toEqual([readOnlyToken('tyler')]);
  await pair({ code, preview: state.preview });
  expect(state.alerts).toHaveLength(2);
});

it('saves and links nothing when a code agreed to as Read only answers with full access', async () => {
  state.profiles = [saved('mine')];
  state.token = 'full-token';
  await expect(pair({ code, preview: state.preview })).rejects.toMatchObject({ code: 'ERR_PAIRING_LEVEL_CHANGED' });
  await expect(pair({ code })).rejects.toMatchObject({ code: 'ERR_PAIRING_LEVEL_CHANGED' });
  expect(state.added).toEqual([]);
  expect(state.linked).toBe(0);
});

it('holds to the answer the person saw, and reads no second one', async () => {
  const seen = state.preview;
  state.preview = { ok: true, group: [{ id: ID, name: 'Tyler' }] };
  state.token = 'full-token';
  await expect(pair({ code, preview: seen })).rejects.toMatchObject({ code: 'ERR_PAIRING_LEVEL_CHANGED' });
  expect(state.previews).toBe(0);
});

it('leaves watched computers out of what a full-access code’s computer is told, so they come back with full access', async () => {
  state.profiles = [saved('mine'), saved('tyler2', 'read')];
  state.preview = { ok: true, group: [{ id: ID, name: 'Tyler' }] };
  state.token = 'full-token';
  await pair({ code });
  expect(state.exchanged.map(request => request.known)).toEqual([['mine']]);
  expect(state.previews).toBe(1);
});
