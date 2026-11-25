import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  profiles: [] as object[],
  preview: {} as object,
  exchanged: [] as { known: string[] }[],
  answerAlert: 0,
  alerts: [] as string[],
  added: [] as { access?: string }[],
}));
const FINGERPRINT = '8J58cPYzLPfxq98gpeqRTxP3zkp1kARV_p2rKUkdeTM';
const ID = '6cphy4hwgmwpp4nl';

vi.mock('@tanstack/react-query', () => ({ useMutation: (options: object) => options }));
vi.mock('expo-haptics', () => ({}));
vi.mock('react-native', () => ({
  Alert: { alert: (title: string, _message: string, buttons: { onPress(): void }[]) => { state.alerts.push(title); buttons[state.answerAlert].onPress(); } },
}));
vi.mock('@/auth/hostsStore', () => {
  const store = { add: async () => undefined, addMany: async (_linked: object[], paired: { access?: string }) => { state.added.push(paired); }, get profiles() { return state.profiles; } };
  return { useHostsStore: Object.assign((select: (value: typeof store) => unknown) => select(store), { getState: () => store }) };
});
vi.mock('@/auth/pairing', () => ({}));
vi.mock('@/daemon/createClient', () => ({
  CLIENT_LABEL: 'Pane', DEVICE_LABEL: 'Phone', getRuntimeId: async () => 'phone',
  createDaemonClient: () => { throw new Error('linking was tried'); },
  streamingFetch: async (url: string, init: { body: string }) => {
    if (url.endsWith('/pair/preview')) return Response.json(state.preview);
    state.exchanged.push(JSON.parse(init.body));
    return Response.json({
      ok: true, token: 'tok', clientId: 'c', access: 'read', linked: [],
      computer: { id: ID, name: 'Tyler', domain: 'runpane.net', address: `https://${ID}.runpane.net`, local: [], fingerprint: FINGERPRINT },
    });
  },
}));

const { usePairing } = await import('./usePairing');
// SAFETY: the mocked useMutation above returns its options, so mutationFn is the hook's own.
const pair = (input: { code: string; watchOnly?: boolean }) => (usePairing() as unknown as { mutationFn(input: object): Promise<object> }).mutationFn(input);

const code = `https://runpane.net/pair#s=secret&c=${ID}&n=Tyler`;
const saved = (id: string, access?: 'read') => ({ id: `relay:${id}`, label: id, baseUrl: `https://${id}.runpane.net`, token: `t-${id}`, access, relay: { computerId: id } });

beforeEach(() => Object.assign(state, {
  profiles: [], exchanged: [], alerts: [], added: [], answerAlert: 1,
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

it('tells a Read only code’s computer only of full-access computers it named itself', async () => {
  state.profiles = [saved('mine'), saved('tyler2'), saved('tyler3', 'read')];
  await pair({ code, watchOnly: true });
  expect(state.exchanged.map(request => request.known)).toEqual([['tyler2']]);
});

it('asks before spending a scanned Read only code, and once only', async () => {
  state.answerAlert = 0;
  await expect(pair({ code })).rejects.toThrow('Not paired');
  expect(state.exchanged).toEqual([]);

  state.answerAlert = 1;
  await pair({ code });
  expect(state.alerts).toEqual(['Watch Tyler', 'Watch Tyler']);
  expect(state.added.map(profile => profile.access)).toEqual(['read']);
  await pair({ code, watchOnly: true });
  expect(state.alerts).toHaveLength(2);
});
