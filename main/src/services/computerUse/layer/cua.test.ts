import { describe, expect, it } from 'vitest';
import { createCua, type LayerHost } from './cua';
import type { ActionOutcome, AppInfo, DesktopDriver, DriverAction, StepRecord, WindowInfo, WindowSnapshot } from './driver';
import type { UiElement } from './tree';

const SHOT = { mime: 'image/png', base64: 'c2hvdA==' };
const WINDOW: WindowInfo = { id: 7, pid: 42, app: 'Notes', title: 'Groceries', zIndex: 3, onScreen: true };

function el(role: string, parent: number | null, extra: Partial<UiElement> = {}): UiElement {
  return { ref: `${role}-${extra.label ?? ''}`, role, parent, actions: [], states: [], ...extra };
}

/**
 * A desktop with one Notes window. `screens` is the sequence of trees each read returns (the last
 * repeats); `refuseBackground` lists action kinds that only work in the foreground.
 */
function fakeDesktop(options: { screens: Array<{ elements: UiElement[]; busy?: boolean }>; refuseBackground?: string[]; staleOnce?: string; clipboard?: { text?: string; restorable: boolean }; apps?: AppInfo[] }) {
  const log: string[] = [];
  let reads = 0;
  let clipboard = options.clipboard ?? { text: 'user copy', restorable: true };
  const driver: DesktopDriver = {
    platform: 'mac',
    listApps: async () => options.apps ?? [{ id: 'com.apple.Notes', displayName: 'Notes', isRunning: true, pid: 42 }],
    listWindows: async () => [WINDOW, { id: 8, pid: 42, app: 'Notes', title: 'Inspector', zIndex: 1, onScreen: true }],
    launchApp: async (app) => {
      log.push(`launch ${app.id}`);
      return 42;
    },
    async readWindow(window): Promise<WindowSnapshot> {
      const screen = options.screens[Math.min(reads, options.screens.length - 1)];
      reads += 1;
      log.push(`read ${window.id}`);
      return { title: window.title, elements: screen.elements, busy: screen.busy === true, screenshot: SHOT };
    },
    async perform(_window, action: DriverAction, { foreground }): Promise<ActionOutcome> {
      log.push(`${action.kind}${foreground ? ' (foreground)' : ''} ${JSON.stringify(action)}`);
      if (!foreground && options.refuseBackground?.includes(action.kind)) return { ok: false, needsForeground: true, message: 'background_unavailable' };
      if (options.staleOnce === action.kind) {
        options.staleOnce = undefined;
        return { ok: false, needsForeground: false, message: 'stale_element_token', stale: true };
      }
      // The engine host shows the notice before a foreground call and returns its line.
      return foreground ? { ok: true, notice: 'Pane: Claude Code is bringing Notes to the front' } : { ok: true };
    },
    readClipboard: async () => clipboard,
    async writeClipboard(text) {
      log.push(`clipboard ${JSON.stringify(text)}`);
      clipboard = { text, restorable: true };
    },
  };
  const output: string[] = [];
  const steps: StepRecord[] = [];
  const host: LayerHost = {
    driver,
    write: (text) => output.push(text),
    emitImage: () => output.push('[image]'),
    recordStep: (step) => steps.push(step),
    async holdLanes(lanes, run) {
      log.push(`hold ${JSON.stringify(lanes)}`);
      try {
        return await run();
      } finally {
        log.push('release');
      }
    },
    settleMs: 0,
    busyPollMs: 1,
    busyTimeoutMs: 200,
  };
  return { cua: createCua(host).cua, log, output, steps };
}

const listScreen = (rows: string[], extra: UiElement[] = []) => ({
  elements: [el('window', null, { label: 'Groceries' }), ...rows.map((label) => el('row', 0, { label })), el('button', 0, { label: 'Add' }), ...extra],
});

describe('cua layer', () => {
  it('getApp binds the frontmost window and shows its full tree', async () => {
    const desk = fakeDesktop({ screens: [listScreen(['Milk'])] });
    const app = await desk.cua.getApp('notes');
    expect(app.windowId).toBe(7);
    expect(desk.output).toEqual([['Notes · "Groceries" · window 7', '1 window "Groceries"', '  2 row "Milk"', '  3 button "Add"'].join('\n')]);
  });

  it('launches an app that is not running, in the background', async () => {
    const desk = fakeDesktop({ screens: [listScreen([])], apps: [{ id: 'com.apple.Notes', displayName: 'Notes', isRunning: false }] });
    await desk.cua.getApp('com.apple.Notes');
    expect(desk.log[0]).toBe('launch com.apple.Notes');
  });

  it('after an action, a read lists only what changed, with ids from the earlier read', async () => {
    const desk = fakeDesktop({ screens: [listScreen(['Milk']), listScreen(['Milk', 'Eggs'])] });
    const app = await desk.cua.getApp('Notes');
    await app.click(3);
    const state = await app.getAXState({ emit: false });
    expect(state).toBe(['Notes · "Groceries" · window 7', 'Changes since the last read: 1 added, 0 removed, 0 changed.', '+ 4 row "Eggs"'].join('\n'));
    expect(await app.getAXState({ disableDiffing: true, emit: false })).toContain('  2 row "Milk"\n  4 row "Eggs"\n  3 button "Add"');
  });

  it('waits while the app reports busy before reading', async () => {
    const spinner = el('progressIndicator', 0);
    const desk = fakeDesktop({ screens: [listScreen([]), { ...listScreen([], [spinner]), busy: true }, { ...listScreen([], [spinner]), busy: true }, listScreen(['Loaded'])] });
    const app = await desk.cua.getApp('Notes');
    await app.click(2);
    // Two busy reads, then the settled one; the agent's next read shows the loaded row.
    expect(desk.log.filter((line) => line.startsWith('read'))).toHaveLength(4);
    expect(await app.getAXState({ emit: false })).toContain('+ 4 row "Loaded"');
  });

  it('records each action as a step with the settled screenshot', async () => {
    const desk = fakeDesktop({ screens: [listScreen(['Milk'])] });
    const app = await desk.cua.getApp('Notes');
    await app.click(2, { mouseButton: 'r' });
    await app.pressKey('super+a');
    expect(desk.steps).toEqual([
      { index: 0, action: 'click', args: { app: 'Notes', windowId: 7, target: 2, button: 'right', clickCount: 1 }, result: 'ok', screenshot: { mime: 'image/png', base64: 'c2hvdA==' }, at: expect.any(String) },
      { index: 1, action: 'pressKey', args: { app: 'Notes', windowId: 7, key: 'super+a' }, result: 'ok', screenshot: { mime: 'image/png', base64: 'c2hvdA==' }, at: expect.any(String) },
    ]);
  });

  it('refuses background input with the needs_foreground copy, and a foreground retry puts the notice line in the result once', async () => {
    const desk = fakeDesktop({ screens: [listScreen(['Milk'])], refuseBackground: ['scroll'] });
    const app = await desk.cua.getApp('Notes');
    await expect(app.scroll(2, 'd')).rejects.toThrow(
      "needs_foreground: Notes can't receive scrolling in the background on this OS. Retry with { foreground: true } to bring it to the front; the user will see a notice first.",
    );
    await app.scroll(2, 'down', 2, { foreground: true });
    expect(desk.log).toContainEqual(expect.stringMatching(/^scroll \(foreground\) .*"direction":"down","amount":2,"by":"page"/));
    // Three foreground calls, one line.
    await app.typeText('a\nb', { foreground: true });
    expect(desk.output.filter((line) => line === 'Pane: Claude Code is bringing Notes to the front')).toHaveLength(2);
    expect(desk.steps.map((s) => s.result)).toEqual([expect.stringMatching(/^needs_foreground: /), 'ok', 'ok']);
  });

  it('re-reads and retries once when another read replaced the engine handles', async () => {
    const desk = fakeDesktop({ screens: [listScreen(['Milk'])], staleOnce: 'click' });
    const app = await desk.cua.getApp('Notes');
    await app.click(2);
    expect(desk.log.filter((line) => /^(read|click)/.test(line)).map((line) => line.split(' ')[0])).toEqual(['read', 'click', 'read', 'click', 'read']);
    expect(desk.steps[0].result).toBe('ok');
  });

  it('rejects an element id the window no longer has', async () => {
    const desk = fakeDesktop({ screens: [listScreen(['Milk'])] });
    const app = await desk.cua.getApp('Notes');
    await expect(app.click(99)).rejects.toThrow("Element 99 isn't in Notes's window now. Call getAXState() and use an id from it.");
  });

  it('paste puts the user clipboard back afterwards', async () => {
    const desk = fakeDesktop({ screens: [listScreen([])] });
    const app = await desk.cua.getApp('Notes');
    await app.paste('# Title', { format: 'md' });
    expect(desk.log.filter((line) => /^(clipboard|pressKey)/.test(line))).toEqual([
      'clipboard "# Title"',
      'pressKey {"kind":"pressKey","key":"super+v"}',
      'clipboard "user copy"',
    ]);
  });

  it('paste types instead when the clipboard holds something it could not restore', async () => {
    const desk = fakeDesktop({ screens: [listScreen([])], clipboard: { restorable: false } });
    const app = await desk.cua.getApp('Notes');
    await app.paste('hello');
    expect(desk.log.some((line) => line.startsWith('clipboard'))).toBe(false);
    expect(desk.steps[0].result).toMatch(/^ok: typed instead of pasting/);
  });

  it('holds the app (and the clipboard, for paste) for all of an action\'s engine calls, then settles', async () => {
    const desk = fakeDesktop({ screens: [listScreen([])] });
    const app = await desk.cua.getApp('Notes');
    desk.log.length = 0;
    await app.typeText('a\nb');
    expect(desk.log.map((line) => line.split(' ')[0])).toEqual(['hold', 'typeText', 'pressKey', 'typeText', 'release', 'read']);
    expect(desk.log[0]).toBe('hold {"pid":42,"clipboard":false}');
    desk.log.length = 0;
    await app.paste('x');
    expect(desk.log[0]).toBe('hold {"pid":42,"clipboard":true}');
    expect(desk.log.indexOf('release')).toBeGreaterThan(desk.log.lastIndexOf('clipboard "user copy"'));
  });

  it('typeText presses Return for each newline', async () => {
    const desk = fakeDesktop({ screens: [listScreen([])] });
    const app = await desk.cua.getApp('Notes');
    await app.typeText('a\nb');
    expect(desk.log.filter((line) => /^(typeText|pressKey)/.test(line)).map((line) => line.split(' ')[1])).toEqual([
      '{"kind":"typeText","text":"a"}',
      '{"kind":"pressKey","key":"Return"}',
      '{"kind":"typeText","text":"b"}',
    ]);
  });

  it('selectText finds the text by prefix and suffix and selects its range', async () => {
    const field = el('textField', 0, { label: 'Note', value: 'one two one three' });
    const desk = fakeDesktop({ screens: [{ elements: [el('window', null), field] }] });
    const app = await desk.cua.getApp('Notes');
    await app.selectText(2, 'one', { prefix: 'two ' });
    await app.selectText(2, 'two', { selectionType: 'cursor_after' });
    const selections = desk.log.filter((line) => line.startsWith('selectText')).map((line) => JSON.parse(line.slice(line.indexOf('{'))));
    expect(selections.map(({ start, length }) => [start, length])).toEqual([[8, 3], [7, 0]]);
    await expect(app.selectText(2, 'four')).rejects.toThrow('Element 2 doesn\'t contain "four".');
  });
});
