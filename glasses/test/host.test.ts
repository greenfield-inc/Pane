import { describe, expect, it, vi } from 'vitest';
import { encodeGlassesPairingCode } from '../../shared/types/glasses';
import type { NotifyItem, NotifySharedState } from '../../shared/types/notify';
import { boundary, decodeBoundary, type JsonValue } from '../../shared/validation/boundaryDecoder';
import { HostHub, pairComputers, type HostDeps, type PairedComputer } from '../src/host';
import type { Cancel } from '../src/timers';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Handler = (args: JsonValue[]) => JsonValue | NotifySharedState;

/** A Pane computer's workspace listener, in memory: /health, /events (SSE) and /invoke. */
class FakeHost {
  readonly seen: Seen[] = [];
  readonly handlers = new Map<string, Handler>();
  /** When set, every request gets this status and `{ ok: false, error }` body. */
  refuse: { status: number; code: string; message: string; next?: string } | null = null;
  /** When set, requests fail the way a refused CORS preflight looks to a page: a network error. */
  unreachable = false;
  /**
   * When set, the app's origin is not allowed: a request with a token needs a CORS preflight,
   * which fails as a network error, while a plain GET gets the host's readable 403.
   */
  originRemoved = false;
  /** Commands this host's Pane doesn't let glasses run, as an older Pane refuses them. */
  readonly refusedChannels = new Set<string>();
  private streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];

  constructor(readonly url: string) {}

  fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> => {
    this.seen.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? '' });
    if (this.unreachable) throw new TypeError('Load failed');
    if (this.originRemoved) {
      if (init.headers?.Authorization || init.method === 'POST') throw new TypeError('Load failed');
      return Response.json({ ok: false, error: { message: 'Workspaces answer the runpane CLI, not browsers.', code: 'ERR_WORKSPACE_BROWSER_REFUSED' } }, { status: 403 });
    }
    if (this.refuse) {
      const { status, ...error } = this.refuse;
      return Response.json({ ok: false, error }, { status });
    }
    const path = url.slice(this.url.length);
    if (path === '/health') return Response.json({ ok: true });
    if (path === '/events') {
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.streams.push(controller);
          controller.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const request = decodeBoundary(JSON.parse(init.body ?? '{}'), boundary.object({ channel: boundary.string, args: boundary.array(boundary.json) }));
    if (this.refusedChannels.has(request.channel)) {
      return Response.json({ ok: false, error: { message: `Glasses can't run ${request.channel}.`, code: 'ERR_GLASSES_CHANNEL_REFUSED' } }, { status: 403 });
    }
    const handler = this.handlers.get(request.channel);
    if (!handler) return Response.json({ ok: false, error: { message: `no ${request.channel}`, code: 'ERR_TEST' } }, { status: 403 });
    return Response.json({ ok: true, result: handler(request.args) });
  };

  /** Ends every open event stream, as the host does when it revokes the glasses. */
  closeStreams(): void {
    for (const stream of this.streams) stream.close();
    this.streams = [];
  }

  emit(channel: string, arg: NotifySharedState | JsonValue): void {
    const data = JSON.stringify({ channel, args: [arg], timestamp: new Date().toISOString() });
    for (const stream of this.streams) stream.enqueue(new TextEncoder().encode(`event: daemon-event\ndata: ${data}\n\n`));
  }
}

function item(id: string, createdAt: number, partial: Partial<NotifyItem> = {}): NotifyItem {
  return { id, ui: 'options', title: `question ${id}`, choices: [{ label: 'Yes' }], state: 'waiting', createdAt, source: { name: `pane-${id}`, agent: 'Claude' }, ...partial };
}

function notifyState(machine: string, revision: number, items: NotifyItem[]): NotifySharedState {
  return { machine, epoch: 'e1', revision, enabled: true, items, queue: [], hidden: [] };
}

function host(url: string, items: NotifyItem[] = []): FakeHost {
  const fake = new FakeHost(url);
  fake.handlers.set('notify:remote-snapshot', () => notifyState(new URL(url).hostname.split('.')[0] ?? 'host', 1, items));
  fake.handlers.set('sessions:get-all-with-projects', () => ({ success: true, data: [] }));
  fake.handlers.set('orchestration-sessions:list', () => ({ success: true, data: { sessions: [] } }));
  fake.handlers.set('runpane:workspace:state', () => ({ ok: true, entries: [] }));
  // A Pane older than the OS report answers without `os`.
  fake.handlers.set('remote:pwa-affordances', () => ({}));
  // No computer of yours lacks the glasses.
  fake.handlers.set('runpane:glasses:vouch', () => ({ code: null, expiresAt: null, skipped: [] }));
  return fake;
}

/** Hand-run timers for the hub's own retries; the shared client keeps real timers. */
function manualTimers() {
  let now = 1_000_000;
  const tasks: Array<{ at: number; fn: () => void; done: boolean }> = [];
  return {
    now: () => now,
    later: (fn: () => void, ms: number): Cancel => {
      const task = { at: now + ms, fn, done: false };
      tasks.push(task);
      return { cancel: () => { task.done = true; } };
    },
    advance(ms: number) {
      now += ms;
      for (const task of tasks.filter((candidate) => !candidate.done && candidate.at <= now)) {
        task.done = true;
        task.fn();
      }
    },
  };
}

/** A hub paired with `hosts`; it can reach those and `others`, which it isn't paired with. */
function hub(hosts: FakeHost[], timers = manualTimers(), saved: PairedComputer[][] = [], others: FakeHost[] = []) {
  const paired: PairedComputer[] = hosts.map((fake, index) => ({ name: `computer-${index}`, url: fake.url, token: `pgt_token${index}`, deviceLabel: 'Even G2 · iPhone' }));
  const deps: HostDeps = {
    fetch: async (url, init) => {
      const target = [...hosts, ...others].find((fake) => String(url).startsWith(fake.url));
      if (!target) throw new TypeError('Failed to fetch');
      // SAFETY: the shared client sends string headers and a string body.
      return target.fetch(String(url), init as { method?: string; headers?: Record<string, string>; body?: string });
    },
    runtimeId: 'runtime-1',
    later: timers.later,
    now: timers.now,
    openSocket: () => { throw new Error('no sockets in tests'); },
    origin: 'https://even.example',
    savePaired: async (all) => { saved.push(all); },
  };
  const result = new HostHub(paired, deps);
  result.start();
  return { hub: result, timers };
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('pairing', () => {
  it('trades each computer’s secret once, in the body, and keeps only the device token', async () => {
    const studio = new FakeHost('https://studio.tail1.ts.net:8443');
    studio.handlers.set('runpane:glasses:pair', () => ({ token: 'pgt_studio', device: { id: 'glasses-1', label: 'Even G2 · iPhone', createdAt: '2026-10-28T00:00:00Z' } }));
    const devbox = new FakeHost('https://devbox.tail1.ts.net:8443');
    devbox.refuse = { status: 403, code: 'ERR_GLASSES_PAIRING_SECRET_INVALID', message: 'This pairing code was already used or is more than 10 minutes old.', next: 'Make a new code in the Pane app.' };
    const code = encodeGlassesPairingCode({
      v: 1,
      expiresAt: '2026-10-28T00:10:00Z',
      computers: [
        { name: 'studio-mac', url: studio.url, secret: 'pgs_studio' },
        { name: 'devbox', url: devbox.url, secret: 'pgs_devbox' },
      ],
    });
    const outcome = await pairComputers(code, {
      fetch: async (url, init) => ((String(url).startsWith(studio.url) ? studio : devbox).fetch(String(url), {
        method: init?.method,
        // SAFETY: pairComputers sends a plain header record and a string body.
        headers: init?.headers as Record<string, string>,
        body: String(init?.body),
      })),
      runtimeId: 'runtime-1',
      clientLabel: 'Pane glasses',
      origin: 'https://even.example',
    });
    expect(outcome.paired).toEqual([{ name: 'studio-mac', url: studio.url, token: 'pgt_studio', deviceLabel: 'Even G2 · iPhone' }]);
    expect(outcome.failed).toEqual([{ name: 'devbox', url: devbox.url, code: 'ERR_GLASSES_PAIRING_SECRET_INVALID', message: 'This pairing code was already used or is more than 10 minutes old.', next: 'Make a new code in the Pane app.' }]);
    const sent = studio.seen[0];
    expect(sent?.url).toBe(`${studio.url}/invoke`);
    expect(sent?.headers.Authorization).toBeUndefined();
    expect(JSON.parse(sent?.body ?? '{}')).toMatchObject({ channel: 'runpane:glasses:pair', args: [{ secret: 'pgs_studio' }] });
    expect(sent?.url).not.toContain('pgs_');
  });

  it('refuses a code that is not a Pane glasses code', async () => {
    await expect(pairComputers('https://example.com#token', { fetch, runtimeId: 'r', clientLabel: 'Pane glasses', origin: 'https://even.example' })).rejects.toThrow('not a Pane glasses code');
  });

  it("points to Allow when a computer doesn't answer, since an unallowed origin looks like a network error", async () => {
    const url = 'https://studio.tail1.ts.net:8443';
    const code = encodeGlassesPairingCode({ v: 1, expiresAt: '2026-10-28T00:10:00Z', computers: [{ name: 'studio-mac', url, secret: 'pgs_studio' }] });
    const outcome = await pairComputers(code, {
      fetch: async () => { throw new TypeError('Load failed'); },
      runtimeId: 'runtime-1',
      clientLabel: 'Pane glasses',
      origin: 'https://even.example',
    });
    expect(outcome.paired).toEqual([]);
    expect(outcome.failed).toEqual([{
      name: 'studio-mac',
      url,
      code: 'ERR_GLASSES_NO_ANSWER',
      message: "studio-mac didn't answer. If this is the first time, allow the Even app on it: Pane › Settings › Remote Access › Glasses › Allow (origin https://even.example).",
      next: 'Then paste again.',
    }]);
  });
});

describe('joining your other computers on their own', () => {
  it('pairs with the code a paired computer vouches with as a pasted one, stores it with the others, and lists it', async () => {
    const studio = host('https://studio.tail1.ts.net:8443');
    const office = host('https://office.tail1.ts.net:8443');
    office.handlers.set('runpane:glasses:pair', () => ({ token: 'pgt_office', device: { id: 'glasses-9', label: 'Even G2 · iPhone', createdAt: '2026-10-30T00:00:00Z' } }));
    const code = encodeGlassesPairingCode({ v: 1, expiresAt: '2026-10-30T00:10:00Z', computers: [{ name: 'office-pc', url: office.url, secret: 'pgs_office' }] });
    studio.handlers.set('runpane:glasses:vouch', () => ({ code, expiresAt: '2026-10-30T00:10:00Z', skipped: [{ name: 'nas', reason: 'needs its password' }] }));
    const saved: PairedComputer[][] = [];
    const { hub: live } = hub([studio], manualTimers(), saved, [office]);
    await until(() => live.computers().length === 2 && live.computers()[1]?.status === 'live');
    expect(saved.at(-1)).toEqual([
      { name: 'computer-0', url: studio.url, token: 'pgt_token0', deviceLabel: 'Even G2 · iPhone' },
      { name: 'office-pc', url: office.url, token: 'pgt_office', deviceLabel: 'Even G2 · iPhone' },
    ]);
    expect(live.computers().map((computer) => computer.name)).toEqual(['computer-0', 'office-pc']);
    const vouch = studio.seen.find((seen) => seen.body.includes('runpane:glasses:vouch'));
    expect(JSON.parse(vouch?.body ?? '{}')).toMatchObject({ channel: 'runpane:glasses:vouch', args: [] });
    expect(office.seen.some((seen) => seen.url.endsWith('/events') && seen.headers.Authorization === 'Bearer pgt_office')).toBe(true);
    expect(live.unjoined()).toEqual([{ name: 'nas', reason: 'needs its password' }]);
    live.stop();
  });
});

/** Lets fetch bodies and promise chains run without any timer. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('HostHub', () => {
  it('shows a revoke while idle, with the global timers stalled as the Even SDK leaves them', async () => {
    const a = host('https://studio.tail1.ts.net:8443', [item('a1', 100)]);
    const { hub: one, timers } = hub([a]);
    await until(() => one.computers()[0]?.status === 'live');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      a.refuse = { status: 401, code: 'ERR_GLASSES_TOKEN_INVALID', message: 'These glasses are not paired with this computer, or were revoked.', next: 'Pair again from the Pane app.' };
      a.closeStreams();
      for (let step = 0; step < 50 && one.computers()[0]?.status !== 'refused'; step += 1) {
        timers.advance(1_000);
        await flush();
      }
      expect(one.computers()[0]?.refusal?.code).toBe('ERR_GLASSES_TOKEN_INVALID');
    } finally {
      vi.useRealTimers();
      one.stop();
    }
  });

  it('merges every computer’s cards, questions first and newest first, each with its own token', async () => {
    const a = host('https://studio.tail1.ts.net:8443', [item('a1', 100), item('a2', 400, { ui: 'info', state: 'info' })]);
    const b = host('https://devbox.tail1.ts.net:8443', [item('b1', 200), item('b2', 300, { state: 'answered' })]);
    const { hub: merged } = hub([a, b]);
    await until(() => merged.cards().length === 3);
    expect(merged.cards().map((card) => `${card.machine}:${card.itemId}`)).toEqual(['devbox:b1', 'studio:a1', 'studio:a2']);
    expect(merged.computers().map((computer) => computer.status)).toEqual(['live', 'live']);
    for (const [fake, token] of [[a, 'pgt_token0'], [b, 'pgt_token1']] as const) {
      for (const request of fake.seen.filter((seen) => !seen.url.endsWith('/health'))) {
        expect(request.headers.Authorization).toBe(`Bearer ${token}`);
        expect(request.headers['X-Pane-Client-Label']).toBe('Even G2 · iPhone');
      }
      for (const request of fake.seen) expect(request.url).not.toContain('pgt_');
    }
    merged.stop();
  });

  it('applies Notify changes from the event stream and ignores an older state', async () => {
    const a = host('https://studio.tail1.ts.net:8443', [item('a1', 100)]);
    const { hub: one } = hub([a]);
    await until(() => one.cards().length === 1);
    a.emit('notify:shared-changed', notifyState('studio', 5, [item('a1', 100), item('a3', 500)]));
    await until(() => one.cards().length === 2);
    a.emit('notify:shared-changed', notifyState('studio', 4, []));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(one.cards().map((card) => card.itemId)).toEqual(['a3', 'a1']);
    one.stop();
  });

  it('sends answers and dictation with the commands the host scopes glasses to', async () => {
    const a = host('https://studio.tail1.ts.net:8443', [item('a1', 100)]);
    const calls: Array<[string, JsonValue[]]> = [];
    a.handlers.set('notify:remote-command', (args) => { calls.push(['notify:remote-command', args]); return null; });
    a.handlers.set('runpane:panels:submit', (args) => { calls.push(['runpane:panels:submit', args]); return { ok: true }; });
    const { hub: one } = hub([a]);
    await until(() => one.cards().length === 1);
    const [card] = one.cards();
    if (!card) throw new Error('no card');
    await one.answer(card, { choice: 'Yes' });
    await one.submit(card.computerId, 'panel-1', 'rerun the tests');
    expect(calls).toEqual([
      ['notify:remote-command', [{ type: 'answer', id: 'a1', answer: { choice: 'Yes' } }]],
      ['runpane:panels:submit', [{ panelId: 'panel-1', input: 'rerun the tests', source: 'user' }]],
    ]);
    one.stop();
  });

  it('presses one key at a time, as the bytes a terminal reads, sent as the user', async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    const sent: JsonValue[] = [];
    a.handlers.set('runpane:panels:input', ([request]) => { sent.push(request ?? null); return { ok: true }; });
    const { hub: one } = hub([a]);
    await until(() => one.computers()[0]?.status === 'live');
    for (const key of ['up', 'down', 'enter', 'escape', 'tab', '4'] as const) await one.key(a.url, 'panel-1', key);
    expect(sent).toEqual(['\u001b[A', '\u001b[B', '\r', '\u001b', '\t', '4'].map((input) => ({ panelId: 'panel-1', input, source: 'user' })));
    one.stop();
  });

  it('reads a terminal screen through a drop once the computer answers again', async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    a.handlers.set('runpane:panels:screen', () => ({ text: '$ npm test\nok', state: { running: true } }));
    const { hub: one, timers } = hub([a]);
    await until(() => one.computers()[0]?.status === 'live');
    a.unreachable = true;
    a.closeStreams();
    const read = one.screen(a.url, 'panel-1');
    for (let step = 0; step < 10; step += 1) {
      timers.advance(1_000);
      await flush();
    }
    a.unreachable = false;
    for (let step = 0; step < 20; step += 1) {
      timers.advance(1_000);
      await flush();
    }
    await expect(read).resolves.toMatchObject({ lines: ['$ npm test', 'ok'] });
    one.stop();
  });

  it("says a computer on an older Pane can't take keys yet, and keeps it live however often it refuses", async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    a.refusedChannels.add('runpane:panels:input');
    const { hub: one } = hub([a]);
    await until(() => one.computers()[0]?.status === 'live');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(one.key(a.url, 'panel-1', 'down')).rejects.toMatchObject({
        code: 'ERR_GLASSES_KEYS_UNSUPPORTED',
        message: "computer-0's Pane can't take keys from the glasses yet.",
        next: 'Update Pane on computer-0.',
      });
    }
    expect(one.computers()[0]?.status).toBe('live');
    one.stop();
  });

  it('lists unarchived Sessions and Panes with the terminal each opens', async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    a.handlers.set('sessions:get-all-with-projects', () => ({ success: true, data: [{ sessions: [
      { id: 'p1', name: 'fix-login', archived: false }, { id: 'p2', name: 'old', archived: true }, { id: 'internal-1', name: 'hidden', archived: false },
    ] }] }));
    a.handlers.set('orchestration-sessions:list', () => ({ success: true, data: { sessions: [
      { id: 's1', name: 'even g2 app', archived: false, agent: 'claude', internalSessionId: 'internal-1', panelIds: { claude: 'sp1', codex: 'sp2' } },
      { id: 's2', name: 'archived session', archived: true, agent: 'claude', internalSessionId: 'internal-2', panelIds: { claude: 'sp3', codex: 'sp4' } },
    ] } }));
    const panels: JsonValue[] = [
      { id: 'diff', type: 'diff', title: 'Diff', state: {} },
      { id: 'term', type: 'terminal', title: 'Claude', state: { customState: { agentType: 'claude' } } },
    ];
    a.handlers.set('panels:list', ([paneId]) => ({ success: true, data: paneId === 'p1' ? panels : [] }));
    a.handlers.set('runpane:workspace:state', () => ({ ok: true, entries: [{ panelId: 'term', to: 'working', running: true, baseline: true }] }));
    const { hub: one } = hub([a]);
    await until(() => (one.computers()[0]?.entries.length ?? 0) > 0);
    expect(one.computers()[0]?.entries).toEqual([
      { kind: 'session', id: 's1', name: 'even g2 app', agent: 'Claude', status: 'idle', panelId: 'sp1' },
      { kind: 'pane', id: 'p1', name: 'fix-login', agent: 'Claude', status: 'working', panelId: 'term' },
    ]);
    expect(one.computers()[0]?.os).toBeNull();
    one.stop();
  });

  it('keeps the Pane apps\' order among rows with no time: Pinned, Sessions, then Panes', async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    const panes: JsonValue[] = [
      { id: 'p1', name: 'alpha', isFavorite: true, favoritePinnedAt: '2026-10-01T00:00:00.000Z' },
      { id: 'p2', name: 'beta', isFavorite: false },
      { id: 'p3', name: 'gamma', isFavorite: true, favoritePinnedAt: '2026-10-20T00:00:00.000Z' },
      { id: 'p4', name: 'hidden', isFavorite: false, isHidden: true },
    ];
    a.handlers.set('sessions:get-all-with-projects', () => ({ success: true, data: [{ sessions: panes }] }));
    a.handlers.set('orchestration-sessions:list', () => ({ success: true, data: { sessions: [
      { id: 's1', name: 'plain', isPinned: false, agent: 'claude', internalSessionId: 'i1', panelIds: { claude: 'sp1' } },
      { id: 's2', name: 'starred', isPinned: true, agent: 'claude', internalSessionId: 'i2', panelIds: { claude: 'sp2' } },
    ] } }));
    a.handlers.set('panels:list', ([paneId]) => ({ success: true, data: [{ id: `t-${String(paneId)}`, type: 'terminal', title: 'Terminal', state: { isActive: true, customState: { isInitialized: true } } }] }));
    const { hub: one } = hub([a]);
    await until(() => (one.computers()[0]?.entries.length ?? 0) > 0);
    expect(one.computers()[0]?.entries.map((entry) => entry.name)).toEqual(['starred', 'gamma', 'alpha', 'plain', 'beta']);
    one.stop();
  });

  it('lists Panes newest first across every repository', async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    a.handlers.set('sessions:get-all-with-projects', () => ({ success: true, data: [
      { sessions: [{ id: 'p1', name: 'oldest', createdAt: '2026-10-01T00:00:00.000Z' }, { id: 'p3', name: 'newest', createdAt: '2026-10-28T00:00:00.000Z' }] },
      { sessions: [{ id: 'p2', name: 'middle', createdAt: '2026-10-15T00:00:00.000Z' }] },
    ] }));
    a.handlers.set('panels:list', ([paneId]) => ({ success: true, data: [{ id: `t-${String(paneId)}`, type: 'terminal', title: 'Terminal', state: { isActive: true, customState: { isInitialized: true } } }] }));
    const { hub: one } = hub([a]);
    await until(() => (one.computers()[0]?.entries.length ?? 0) > 0);
    expect(one.computers()[0]?.entries.map((entry) => entry.name)).toEqual(['newest', 'middle', 'oldest']);
    one.stop();
  });

  it("reads each row's last activity, and the OS the computer reports", async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    a.handlers.set('remote:pwa-affordances', () => ({ os: 'Linux' }));
    const panes: JsonValue[] = [
      { id: 'p1', name: 'busy', createdAt: '2026-10-01T00:00:00.000Z', lastActivity: '2026-10-29T10:30:00.000Z' },
      { id: 'p2', name: 'quiet', createdAt: '2026-10-01T00:00:00.000Z' },
    ];
    a.handlers.set('sessions:get-all-with-projects', () => ({ success: true, data: [{ sessions: panes }] }));
    a.handlers.set('orchestration-sessions:list', () => ({ success: true, data: { sessions: [
      { id: 's1', name: 'planner', agent: 'claude', internalSessionId: 'i1', panelIds: { claude: 'sp1' }, updatedAt: '2026-10-28T09:00:00.000Z' },
    ] } }));
    a.handlers.set('panels:list', ([paneId]) => ({ success: true, data: [{ id: `t-${String(paneId)}`, type: 'terminal', title: 'Terminal', state: { isActive: true, customState: { isInitialized: true } } }] }));
    const { hub: one } = hub([a]);
    await until(() => one.computers()[0]?.os === 'Linux' && (one.computers()[0]?.entries.length ?? 0) > 0);
    expect(one.computers()[0]?.entries.map((entry) => [entry.name, entry.activityAt])).toEqual([
      ['planner', 1793178000000],
      ['busy', 1793269800000],
      ['quiet', 1790812800000],
    ]);
    one.stop();
  });

  it('lists a new Pane a second after its computer announces it', async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    a.handlers.set('panels:list', ([paneId]) => ({ success: true, data: [{ id: `t-${String(paneId)}`, type: 'terminal', title: 'Terminal', state: { isActive: true, customState: { isInitialized: true } } }] }));
    const { hub: one, timers } = hub([a]);
    await until(() => one.computers()[0]?.status === 'live');
    a.handlers.set('sessions:get-all-with-projects', () => ({ success: true, data: [{ sessions: [{ id: 'p9', name: 'just-made' }] }] }));
    a.emit('panel:created', {});
    await flush();
    timers.advance(999);
    await flush();
    expect(one.computers()[0]?.entries).toEqual([]);
    timers.advance(1);
    await until(() => (one.computers()[0]?.entries.length ?? 0) > 0);
    expect(one.computers()[0]?.entries.map((entry) => entry.name)).toEqual(['just-made']);
    one.stop();
  });

  it('reads the Panes again ten seconds after a failed read', async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    a.handlers.set('panels:list', ([paneId]) => ({ success: true, data: [{ id: `t-${String(paneId)}`, type: 'terminal', title: 'Terminal', state: { isActive: true, customState: { isInitialized: true } } }] }));
    // An answer the glasses can't read fails the list read, while Notify and the stream stay up.
    a.handlers.set('sessions:get-all-with-projects', () => ({ success: true, data: 'database is locked' }));
    const { hub: one, timers } = hub([a]);
    await until(() => one.computers()[0]?.status === 'live');
    a.handlers.set('sessions:get-all-with-projects', () => ({ success: true, data: [{ sessions: [{ id: 'p1', name: 'api' }] }] }));
    timers.advance(9_999);
    await flush();
    expect(one.computers()[0]?.entries).toEqual([]);
    timers.advance(1);
    await until(() => (one.computers()[0]?.entries.length ?? 0) > 0);
    expect(one.computers()[0]?.entries.map((entry) => entry.name)).toEqual(['api']);
    one.stop();
  });

  it('opens the terminal a Pane actually runs, never a tab that was never started', async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    a.handlers.set('sessions:get-all-with-projects', () => ({ success: true, data: [{ sessions: [
      { id: 'tool', name: 'dev-server', archived: false }, { id: 'shells', name: 'shells', archived: false },
    ] }] }));
    const tool: JsonValue[] = [
      { id: 'blank', type: 'terminal', title: 'Terminal', state: { isActive: false, customState: { isInitialized: false } } },
      { id: 'runner', type: 'terminal', title: 'pnpm dev', state: { isActive: false, customState: { isInitialized: true, initialCommand: 'pnpm dev' } } },
    ];
    const shells: JsonValue[] = [
      { id: 'unused', type: 'terminal', title: 'Terminal 1', state: { isActive: false, customState: {} } },
      { id: 'used', type: 'terminal', title: 'Terminal 2', state: { isActive: true, customState: { isInitialized: true } } },
    ];
    a.handlers.set('panels:list', ([paneId]) => ({ success: true, data: paneId === 'tool' ? tool : shells }));
    const { hub: one } = hub([a]);
    await until(() => (one.computers()[0]?.entries.length ?? 0) > 0);
    expect(one.computers()[0]?.entries.map((entry) => [entry.name, entry.panelId])).toEqual([['dev-server', 'runner'], ['shells', 'used']]);
    one.stop();
  });

  it("shows a refusal in the host's words and tries again only every 30 s, or on a press", async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    a.refuse = { status: 403, code: 'ERR_GLASSES_ORIGIN_REFUSED', message: 'This computer accepts glasses tokens only from the Even app; this request came from https://x.example.', next: 'Allow it in Settings › Remote Access › Glasses.' };
    const { hub: one, timers } = hub([a]);
    await until(() => one.computers()[0]?.status === 'refused');
    expect(one.computers()[0]?.refusal).toEqual({ code: 'ERR_GLASSES_ORIGIN_REFUSED', message: a.refuse.message, next: a.refuse.next });
    const sent = a.seen.length;
    timers.advance(20_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(a.seen.length).toBe(sent);
    timers.advance(10_000);
    await until(() => a.seen.length > sent);
    a.refuse = null;
    one.retry(a.url);
    await until(() => one.computers()[0]?.status === 'live');
    one.stop();
  });

  it('never retries a revoked token by itself, since only pairing again can fix it', async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    a.refuse = { status: 401, code: 'ERR_GLASSES_TOKEN_INVALID', message: 'These glasses are not paired with this computer, or were revoked.', next: 'Pair again.' };
    const { hub: one, timers } = hub([a]);
    await until(() => one.computers()[0]?.status === 'refused');
    const sent = a.seen.length;
    timers.advance(600_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(a.seen.length).toBe(sent);
    one.stop();
  });

  it('recovers on the first press once the computer allows the app again, even with its stream still open', async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    const { hub: one } = hub([a]);
    await until(() => one.computers()[0]?.status === 'live');
    a.refuse = { status: 403, code: 'ERR_GLASSES_ORIGIN_REFUSED', message: 'This request came from https://even.example.', next: 'Allow it.' };
    await one.scrollback(a.url, 'panel-1').catch(() => []);
    expect(one.computers()[0]?.status).toBe('refused');
    a.refuse = null;
    one.retry(a.url);
    await until(() => one.computers()[0]?.status === 'live' && !one.computers()[0]?.refusal);
    one.stop();
  });

  it('connects on the first press after a computer that never answered allows the app', async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    a.unreachable = true;
    const { hub: one } = hub([a]);
    await until(() => a.seen.length > 0);
    a.unreachable = false;
    one.retry();
    await until(() => one.computers()[0]?.status === 'live', 1_000);
    one.stop();
  });

  it('tells a removed origin from an unreachable computer, and recovers by itself once allowed again', async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    const { hub: one, timers } = hub([a]);
    await until(() => one.computers()[0]?.status === 'live');
    a.originRemoved = true;
    a.closeStreams();
    for (let step = 0; step < 40 && one.computers()[0]?.status !== 'refused'; step += 1) {
      timers.advance(1_000);
      await flush();
    }
    const refusal = one.computers()[0]?.refusal;
    expect(refusal?.code).toBe('ERR_GLASSES_ORIGIN_REFUSED');
    expect(refusal?.message).toContain('https://even.example');
    a.originRemoved = false;
    for (let step = 0; step < 40 && one.computers()[0]?.status !== 'live'; step += 1) {
      timers.advance(1_000);
      await flush();
    }
    expect(one.computers()[0]?.status).toBe('live');
    one.stop();
  });

  it('shows a computer that does not answer at all as offline, not refused', async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    const { hub: one, timers } = hub([a]);
    await until(() => one.computers()[0]?.status === 'live');
    a.unreachable = true;
    a.closeStreams();
    for (let step = 0; step < 10; step += 1) {
      timers.advance(1_000);
      await flush();
    }
    expect(one.computers()[0]?.status).not.toBe('refused');
    expect(one.computers()[0]?.status).not.toBe('live');
    one.stop();
  });

  it('waits out a lockout for the time the host names, sending nothing meanwhile', async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    a.refuse = { status: 429, code: 'ERR_GLASSES_LOCKED_OUT', message: 'This computer refused too many glasses requests from this device, so it is ignoring it for 30 s.', next: 'Wait 30 s.' };
    const { hub: one, timers } = hub([a]);
    await until(() => one.computers()[0]?.refusal?.code === 'ERR_GLASSES_LOCKED_OUT');
    expect(one.computers()[0]?.refusal?.retryAt).toBe(timers.now() + 30_000);
    timers.advance(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const sent = a.seen.length;
    one.retry();
    timers.advance(29_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(a.seen.length).toBe(sent);
    a.refuse = null;
    timers.advance(1_000);
    await until(() => one.computers()[0]?.status === 'live');
    one.stop();
  });
});
