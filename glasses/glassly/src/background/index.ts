// Pane on Glassly: the shared glasses app, running in Glassly's background runtime and drawing
// through Glassly's scene API. The Even build's main.ts does the same job for the Even app.
import { base64ToBytes, registerMiniapp } from '@glassly/miniapp/background';
import type { RenderElement } from '@glassly/miniapp';
import { GlassesApp } from '../../../src/app';
import { DemoSource } from '../../../src/demo';
import { CLIENT_LABEL, HostHub, STORAGE_KEY, pairComputers, pairedSaver, readPaired, type HostFetch, type PairedStorage, type PairingFailure } from '../../../src/host';
import type { PaneSource } from '../../../src/model';
import type { Page } from '../../../src/page';
import type { Cancel, Gesture } from '../../../src/platform';
import { PollClock } from '../../../src/polling';
import { firstRunPage, pairingFailedPage } from '../../../src/screens';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { PhoneCommand, PhoneComputer, PhoneState } from '../channels';
import { glanceText } from './glance';
import { Notifier, meetingAt } from './notifier';
import { ListFocus, capturedList, renderPage, scrollableText } from './render';
import { tierOf, type Tier } from './tier';
import { TouchMapper } from './touch';
import { glasslyDictation } from './transcription';

const RUNTIME_KEY = 'pane.glasses.runtimeId';
const SESSION_COMPUTER_KEY = 'pane.glasses.lastSessionComputer';
const AMBIENT_KEY = 'pane.glasses.ambient';
/** How often the calendar is read for a meeting under way, and how often its end is checked. */
const CALENDAR_READ_MS = 5 * 60_000;
const MEETING_CHECK_MS = 60_000;
/**
 * The Origin the Glassly build sends on every request. Pane computers admit the Even app's
 * http://127.0.0.1 without an Allow, and Glassly's native fetch sends whatever the app sets.
 */
const ORIGIN = 'http://127.0.0.1';

const later = (fn: () => void, ms: number): Cancel => {
  const timer = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(timer) };
};
const every = (fn: () => void, ms: number): Cancel => {
  const timer = setInterval(fn, ms);
  return { cancel: () => clearInterval(timer) };
};

/** "9:40": no Intl in Glassly's Android runtime is assumed. */
function clock(epochMs: number): string {
  const time = new Date(epochMs);
  const hours = time.getHours() % 12 || 12;
  return `${hours}:${String(time.getMinutes()).padStart(2, '0')}`;
}

function pageText(page: Page): string {
  return page.boxes.flatMap((box) => (box.kind === 'list' ? [box.items.map((item) => `· ${item}`).join('\n')] : box.kind === 'text' ? [box.lines.join('\n')] : [])).join('\n────\n');
}

const commandSchema = boundary.union(
  boundary.object({ type: boundary.literal('hello') }),
  boundary.object({ type: boundary.literal('pair'), code: boundary.string }),
  boundary.object({ type: boundary.literal('forget') }),
  boundary.object({ type: boundary.literal('demo') }),
  boundary.object({ type: boundary.literal('ambient'), on: boundary.boolean }),
);

registerMiniapp(async (session) => {
  const storage: PairedStorage = {
    getLocalStorage: async (key) => (await session.storage.get(key)) ?? '',
    setLocalStorage: async (key, value) => {
      await session.storage.set(key, value);
      return true;
    },
  };
  const read = (key: string) => storage.getLocalStorage(key).catch(() => '');
  const write = (key: string, value: string) => void storage.setLocalStorage(key, value).catch(() => false);
  const fetchHost: HostFetch = (url, init) => fetch(url, {
    method: init?.method ?? 'GET',
    headers: { ...init?.headers, Origin: ORIGIN },
    ...(init?.body === undefined ? {} : { body: init.body }),
  });

  let runtimeId = await read(RUNTIME_KEY);
  if (!runtimeId) {
    runtimeId = crypto.randomUUID();
    write(RUNTIME_KEY, runtimeId);
  }
  let sessionComputer: string | null = (await read(SESSION_COMPUTER_KEY)) || null;
  let ambient = (await read(AMBIENT_KEY)) !== 'off';

  // ---------- the glasses display ----------
  let tier: Tier = tierOf(session.capabilities);
  const focus = new ListFocus();
  let page: Page | null = null;
  let glance = '';
  let rendering = false;
  let pending: RenderElement[] | null = null;
  const send = (elements: RenderElement[]) => {
    pending = elements;
    if (rendering) return;
    rendering = true;
    void (async () => {
      while (pending) {
        const next = pending;
        pending = null;
        try {
          const result = await session.display.render(next);
          if (result.dropped?.length) console.warn(`[Pane glasses] Glassly dropped ${result.dropped.join(', ')}`);
        } catch (error) {
          console.error('[Pane glasses] render failed', error);
        }
      }
      rendering = false;
    })();
  };
  const draw = () => {
    if (tier.kind === 'glance') {
      const width = session.capabilities?.display?.width ?? 576;
      const height = session.capabilities?.display?.height ?? 288;
      send([{ type: 'text', id: 'glance', box: { x: 0, y: 0, w: width, h: height }, text: glance || 'Pane' }]);
      return;
    }
    if (page) send(renderPage(page, focus.show(page), tier.budget));
  };
  const show = (next: Page) => {
    page = next;
    draw();
    publish();
  };

  // ---------- the app ----------
  let app: GlassesApp | null = null;
  let source: PaneSource | null = null;
  let hub: HostHub | null = null;
  let stopSource: (() => void) | null = null;
  let status = '';
  let failed: readonly PairingFailure[] = [];
  let micOff: (() => void) | null = null;
  const polling = new PollClock(later, () => session.visibility === 'foreground');
  let target: (gesture: Gesture) => void = () => {};

  // ---------- notifications ----------
  // Posted through the request a newer Glassly App takes (SDK 0.4.0 has no `post`); an older
  // App refuses it and Pane carries on without notifications.
  const notifier = new Notifier({
    post: (notification) => session.sendRequest({ type: 'miniapp_notification_post', ...notification }),
    dismiss: (id) => session.sendRequest({ type: 'miniapp_notification_dismiss', id }),
  }, (message) => console.warn(message));
  let events: Array<{ title: string; startsAt: string; endsAt: string; allDay: boolean }> = [];
  const readCalendar = () => {
    const now = Date.now();
    session.phone.calendar.listEvents({ startsAt: new Date(now - 12 * 3_600_000), endsAt: new Date(now + MEETING_CHECK_MS), limit: 50 })
      .then((result) => { events = result.events; }, () => { events = []; });
  };
  const notify = () => {
    if (!source || source.demo) return;
    notifier.update({
      asked: source.cards().filter((card) => card.waiting).map((card) => ({ key: card.key, title: card.title, from: `${card.machine} · ${card.paneName}` })),
      inFront: session.visibility === 'foreground' && tier.kind === 'full',
      inUse: hub?.inUse() ?? false,
      meeting: meetingAt(events, Date.now()),
    });
  };
  readCalendar();
  every(readCalendar, CALENDAR_READ_MS);
  every(notify, MEETING_CHECK_MS);
  /** Pane came to the front: show the question its newest notification asked. */
  const openNotified = () => {
    const key = notifier.opened();
    if (key && tier.kind === 'full') app?.showCard(key);
  };

  const publish = () => {
    const computers: PhoneComputer[] = (source?.computers() ?? []).map((computer) => ({
      name: computer.name,
      state: computer.status,
      why: computer.refusal ? `${computer.refusal.message}${computer.refusal.next ? ` ${computer.refusal.next}` : ''}` : computer.hint ?? '',
    }));
    for (const failure of failed) computers.push({ name: failure.name, state: 'not paired', why: `${failure.message}${failure.next ? ` ${failure.next}` : ''}` });
    const state: PhoneState = { status, paired: hub ? (source?.computers().length ?? 0) : 0, demo: source?.demo ?? false, ambient, computers, mirror: page ? pageText(page) : glance };
    session.ui.send('state', state);
  };

  const mic = async (on: boolean): Promise<boolean> => {
    micOff?.();
    micOff = null;
    if (!on) return true;
    micOff = session.mic.onAudioChunk((chunk) => {
      // (assumed: Glassly delivers 16 kHz 16-bit mono PCM to a miniapp; P0 checks. LC3 can't be used.)
      if (chunk.format && !/pcm/i.test(chunk.format)) return;
      app?.handle({ type: 'audio', pcm: base64ToBytes(chunk.data) });
    });
    return true;
  };

  const start = (next: PaneSource) => {
    stopSource?.();
    source = next;
    const started = new GlassesApp({
      source: next,
      show,
      exit: () => session.system.exit(),
      mic,
      later,
      now: Date.now,
      clock,
      lastSessionComputer: {
        read: () => sessionComputer,
        write: (computerId) => {
          sessionComputer = computerId;
          write(SESSION_COMPUTER_KEY, computerId);
        },
      },
      ambient,
    });
    app = started;
    target = (gesture) => started.handle(gesture);
    stopSource = next.subscribe(() => {
      glance = glanceText(next);
      if (tier.kind === 'glance') draw();
      notify();
      publish();
    });
    glance = glanceText(next);
    publish();
  };

  const startDemo = () => {
    status = 'Demo: sample cards and terminals, nothing runs. Paste a pairing code to use your computers.';
    start(new DemoSource(every));
  };

  const boot = async () => {
    hub?.stop();
    hub = null;
    const paired = readPaired(await read(STORAGE_KEY));
    if (paired.length) {
      status = `Paired with ${paired.length} computer${paired.length === 1 ? '' : 's'}.`;
      hub = new HostHub(paired, {
        fetch: fetchHost,
        runtimeId,
        later,
        now: Date.now,
        openSocket: (url, protocols) => new WebSocket(url, protocols),
        origin: ORIGIN,
        savePaired: pairedSaver(storage),
        polling,
        fallbackDictation: (onPreview) => glasslyDictation((onHeard) => session.transcription.on((heard) => onHeard({ text: heard.text, isFinal: heard.isFinal })), later, onPreview),
      });
      start(hub);
      hub.start();
      return;
    }
    stopSource?.();
    source = null;
    app = null;
    status = 'Not paired. In the Pane app on this phone: Settings › Glasses › Pair glasses, then paste the code here.';
    show(firstRunPage());
    target = (gesture) => {
      if (gesture.type === 'press') startDemo();
      else if (gesture.type === 'double') session.system.exit();
    };
  };

  // ---------- input ----------
  // Double tap is Pane's back gesture; unclaimed, Glassly would close the miniapp instead.
  session.input.setClaimedGestures(['double_tap']);
  const touch = new TouchMapper(Date.now);
  session.input.onTouch((data) => {
    polling.now();
    if (tier.kind === 'glance') return;
    const gesture = touch.gesture(data.kind);
    if (!gesture) return;
    // A list draws its own highlight here, as Even's firmware does: swipes move it, a press picks the row.
    const list = page ? capturedList(page) : null;
    if (list && (gesture.type === 'up' || gesture.type === 'down')) {
      if (focus.move(list, gesture.type === 'up' ? -1 : 1)) draw();
      return;
    }
    if (list && gesture.type === 'press') {
      target({ type: 'select', index: focus.selectedIn(list) });
      return;
    }
    const long = page ? scrollableText(page) : null;
    if (long && (gesture.type === 'up' || gesture.type === 'down')) {
      if (focus.scroll(long, gesture.type === 'up' ? -1 : 1)) draw();
      return;
    }
    target(gesture);
  });

  session.on('visibility', (visibility) => {
    target({ type: visibility === 'foreground' ? 'foreground' : 'background' });
    if (visibility === 'foreground') {
      polling.now();
      openNotified();
      draw();
    }
  });
  session.on('launch', () => openNotified());
  session.on('resume', () => {
    polling.now();
    hub?.retry();
  });
  session.on('capabilities', (capabilities) => {
    tier = tierOf(capabilities);
    draw();
  });

  // ---------- the phone screen ----------
  session.ui.onOpen(() => publish());
  session.ui.on('command', (payload) => {
    const command: PhoneCommand | null = decodeOptionalBoundary(payload, commandSchema) ?? null;
    if (!command) return;
    switch (command.type) {
      case 'hello':
        publish();
        return;
      case 'demo':
        if (!hub) startDemo();
        return;
      case 'ambient':
        ambient = command.on;
        app?.setAmbient(ambient);
        write(AMBIENT_KEY, ambient ? 'on' : 'off');
        publish();
        return;
      case 'forget':
        failed = [];
        void storage.setLocalStorage(STORAGE_KEY, '').then(boot);
        return;
      case 'pair':
        status = 'Pairing…';
        publish();
        void pairComputers(command.code, { fetch: fetchHost, runtimeId, clientLabel: CLIENT_LABEL, origin: ORIGIN }).then(async (outcome) => {
          if (outcome.paired.length) await pairedSaver(storage)(outcome.paired);
          const pairedUrls = new Set(readPaired(await read(STORAGE_KEY)).map((computer) => computer.url));
          failed = outcome.failed.filter((failure) => !(failure.code === 'ERR_GLASSES_PAIRING_SECRET_INVALID' && pairedUrls.has(failure.url)));
          if (outcome.paired.length) await boot();
          if (failed.length) {
            status = `Paired with ${outcome.paired.length} of ${outcome.paired.length + failed.length} computers.`;
            if (!hub) show(pairingFailedPage(failed.map((failure) => `${failure.message}${failure.next ? ` ${failure.next}` : ''}`)));
          }
          publish();
        }, (error: Error) => {
          status = error.message;
          publish();
        });
        return;
    }
  });

  await boot();
});
