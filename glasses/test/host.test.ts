import { describe, expect, it } from 'vitest';
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
  private streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];

  constructor(readonly url: string) {}

  fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> => {
    this.seen.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? '' });
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
    const handler = this.handlers.get(request.channel);
    if (!handler) return Response.json({ ok: false, error: { message: `no ${request.channel}`, code: 'ERR_TEST' } }, { status: 403 });
    return Response.json({ ok: true, result: handler(request.args) });
  };

  emit(channel: string, arg: NotifySharedState): void {
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

function hub(hosts: FakeHost[], timers = manualTimers()) {
  const paired: PairedComputer[] = hosts.map((fake, index) => ({ name: `computer-${index}`, url: fake.url, token: `pgt_token${index}`, deviceLabel: 'Even G2 · iPhone' }));
  const deps: HostDeps = {
    fetch: async (url, init) => {
      const target = hosts.find((fake) => String(url).startsWith(fake.url));
      if (!target) throw new TypeError('Failed to fetch');
      // SAFETY: the shared client sends string headers and a string body.
      return target.fetch(String(url), init as { method?: string; headers?: Record<string, string>; body?: string });
    },
    runtimeId: 'runtime-1',
    later: timers.later,
    now: timers.now,
    openSocket: () => { throw new Error('no sockets in tests'); },
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
    });
    expect(outcome.paired).toEqual([{ name: 'studio-mac', url: studio.url, token: 'pgt_studio', deviceLabel: 'Even G2 · iPhone' }]);
    expect(outcome.failed).toEqual([{ name: 'devbox', message: 'This pairing code was already used or is more than 10 minutes old.', next: 'Make a new code in the Pane app.' }]);
    const sent = studio.seen[0];
    expect(sent?.url).toBe(`${studio.url}/invoke`);
    expect(sent?.headers.Authorization).toBeUndefined();
    expect(JSON.parse(sent?.body ?? '{}')).toMatchObject({ channel: 'runpane:glasses:pair', args: [{ secret: 'pgs_studio' }] });
    expect(sent?.url).not.toContain('pgs_');
  });

  it('refuses a code that is not a Pane glasses code', async () => {
    await expect(pairComputers('https://example.com#token', { fetch, runtimeId: 'r', clientLabel: 'Pane glasses' })).rejects.toThrow('not a Pane glasses code');
  });
});

describe('HostHub', () => {
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
    await until(() => one.computers()[0]?.status === 'live');
    expect(await one.panes(a.url)).toEqual([
      { kind: 'session', id: 's1', name: 'even g2 app', agent: 'Claude', status: 'idle', panelId: 'sp1' },
      { kind: 'pane', id: 'p1', name: 'fix-login', agent: 'Claude', status: 'working', panelId: 'term' },
    ]);
    one.stop();
  });

  it("shows a refusal in the host's words and waits for a press instead of retrying", async () => {
    const a = host('https://studio.tail1.ts.net:8443');
    a.refuse = { status: 403, code: 'ERR_GLASSES_ORIGIN_REFUSED', message: 'This computer accepts glasses tokens only from the Even app; this request came from https://x.example.', next: 'Allow it in Settings › Remote Access › Glasses.' };
    const { hub: one, timers } = hub([a]);
    await until(() => one.computers()[0]?.status === 'refused');
    expect(one.computers()[0]?.refusal).toEqual({ code: 'ERR_GLASSES_ORIGIN_REFUSED', message: a.refuse.message, next: a.refuse.next });
    const sent = a.seen.length;
    timers.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(a.seen.length).toBe(sent);
    a.refuse = null;
    one.retry();
    await until(() => one.computers()[0]?.status === 'live');
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
