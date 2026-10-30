import { describe, expect, it } from 'vitest';
import { Display, type Page } from '../src/display';
import { homeListPage, homeRows, outlineRowAt } from '../src/homeList';
import type { Card, Computer, PaneEntry } from '../src/model';
import { FakeBridge } from './fakeBridge';

const clock = (epochMs: number) => (epochMs === 9_12 ? '9:12' : '9:40');

const pane = (id: string, activityAt: number, extra: Partial<PaneEntry> = {}): PaneEntry => ({
  kind: 'pane', id, name: id, agent: 'Claude', status: 'idle', panelId: `panel-${id}`, activityAt, ...extra,
});

function computer(id: string, name: string, entries: PaneEntry[], extra: Partial<Computer> = {}): Computer {
  return { id, name, status: 'live', lastSeenAt: 1, os: 'macOS', entries, ...extra };
}

function question(computerId: string, paneId: string, createdAt: number, waiting = true): Card {
  return {
    key: `${computerId}:${paneId}-q`, computerId, machine: computerId, itemId: `${paneId}-q`, ui: waiting ? 'options' : 'info', waiting,
    title: 'Which one?', choices: ['A'], suggestions: [], paneName: paneId, paneId, panelId: `panel-${paneId}`, createdAt,
  };
}

/** Each row of the logo page, in order, as the glasses show it. */
function shownRows(page: Page): string[] {
  return page.boxes.flatMap((box) => (box.kind === 'text' && box.name.startsWith('row') ? [box.lines.join('')] : []));
}

describe('the merged rows', () => {
  it('puts questions first, newest first, then every Session and Pane newest activity first across computers', () => {
    const rows = homeRows(
      [
        computer('studio', 'studio-mac', [pane('add-dark-mode', 100), pane('fix-checkout', 300), pane('rate-limit', 50)]),
        computer('build', 'build-box', [pane('terraform', 200), pane('nightly-backup', 400)], { os: 'Linux' }),
      ],
      [question('studio', 'rate-limit', 20), question('build', 'nightly-backup', 10), question('studio', 'add-dark-mode', 30, false)],
    );
    expect(rows.map((row) => row.key)).toEqual([
      'studio|card:rate-limit-q',
      'build|card:nightly-backup-q',
      'studio|pane:fix-checkout',
      'build|pane:terraform',
      'studio|pane:add-dark-mode',
    ]);
  });

  it('keeps the same Pane id on two computers as two rows', () => {
    const rows = homeRows([computer('studio', 'studio-mac', [pane('p1', 2)]), computer('build', 'build-box', [pane('p1', 1)])], []);
    expect(rows.map((row) => row.key)).toEqual(['studio|pane:p1', 'build|pane:p1']);
  });

  it("keeps an offline computer's rows in their place, marked, and gives one with nothing to list a row of its own", () => {
    const rows = homeRows(
      [
        computer('studio', 'studio-mac', [pane('fix-checkout', 300), pane('add-dark-mode', 100)]),
        computer('travel', 'travel-laptop', [pane('trip-notes', 200)], { status: 'offline', lastSeenAt: 9_12 }),
        computer('laptop', 'laptop', [], { status: 'offline', lastSeenAt: 9_12, os: null }),
      ],
      [],
    );
    expect(rows.map((row) => [row.key, row.status])).toEqual([
      ['studio|pane:fix-checkout', 'live'],
      ['travel|pane:trip-notes', 'offline'],
      ['studio|pane:add-dark-mode', 'live'],
      ['laptop|computer', 'offline'],
    ]);
    expect(shownRows(homeListPage(rows, { selected: 0 }, clock))).toEqual([
      '> studi  fix-checkout · Claude · idle',
      '   trave  trip-notes · offline since 9:12',
      '   studi  add-dark-mode · Claude · idle',
      '   lapto  laptop · offline since 9:12',
      ' ',
      ' ',
    ]);
  });
});

describe('the logo list page', () => {
  const rows = homeRows(
    [
      computer('studio', 'studio-mac', Array.from({ length: 5 }, (_, index) => pane(`s${index}`, 100 - index))),
      computer('build', 'build-box', [pane('b0', 50)], { os: 'Linux' }),
      computer('travel', 'travel-laptop', [pane('t0', 40)], { status: 'offline', lastSeenAt: 9_12, os: null }),
    ],
    [question('build', 'b0', 1)],
  );

  it('heads the list with the questions waiting, and marks the selected row with ">" at full brightness', () => {
    const page = homeListPage(rows, { selected: 1 }, clock);
    const header = page.boxes[0];
    expect(header?.kind === 'text' && header.lines).toEqual(['All computers · 1 needs you']);
    expect(shownRows(page).slice(0, 2)).toEqual(['   build  b0 · needs you', '> studi  s0 · Claude · idle']);
    expect(page.boxes.slice(1, 4).map((box) => (box.kind === 'text' ? box.brightness : null))).toEqual([2, 4, 2]);
  });

  it('draws each row\'s logo, dimmed for an away computer and a plain monitor for an unknown OS', () => {
    const strips = (selected: number) => homeListPage(rows, { selected }, clock).boxes.flatMap((box) => (box.kind === 'image' ? [box.key] : []));
    expect(strips(0)).toEqual(['Linux,macOS,macOS', 'macOS,macOS,macOS']);
    expect(strips(6)).toEqual(['computer:dim', '']);
  });

  it('lets a press on a folded outline row name its computer, and a fold of older rows name nothing', () => {
    const long = homeRows([computer('studio', 'studio-mac', Array.from({ length: 25 }, (_, index) => pane(`s${index}`, 100 - index))), computer('travel', 'travel-laptop', [pane('t0', 40)], { status: 'offline', lastSeenAt: 9_12 })], []);
    const page = homeListPage(long, { selected: 0, marks: 'outline' }, clock);
    const items = page.boxes[1]?.kind === 'list' ? page.boxes[1].items : [];
    expect(items.slice(-3)).toEqual(['○ studi  s17 · Claude · idle', '· 7 older Panes ·', '□ trave  offline since 9:12 · 1 Pane · retry']);
    expect(outlineRowAt(long, 18, clock)).toBeNull();
    expect(outlineRowAt(long, 19, clock)?.key).toBe('travel|pane:t0');
  });
});

describe('the logo list on the glasses', () => {
  const rows = homeRows([computer('studio', 'studio-mac', Array.from({ length: 8 }, (_, index) => pane(`s${index}`, 100 - index)))], []);
  /** The page with its logo strips drawn as empty images, as the WebView's canvas would draw them. */
  const page = (selected: number): Page => {
    const built = homeListPage(rows, { selected }, clock);
    return { boxes: built.boxes.map((box) => (box.kind === 'image' ? { ...box, draw: async () => new Uint8Array([1]) } : box)) };
  };

  it('redraws only the two rows that change on a swipe, and resends the logos on a page turn', async () => {
    const bridge = new FakeBridge();
    const display = new Display(bridge);
    await display.show(page(0));
    expect(bridge.calls.map((call) => call.method)).toEqual(['create', 'image', 'image']);

    bridge.calls.length = 0;
    await display.show(page(1));
    expect(bridge.calls.map((call) => (call.method === 'upgrade' ? call.update.containerName : call.method))).toEqual(['row0', 'row1']);

    bridge.calls.length = 0;
    await display.show(page(6));
    expect(bridge.calls.filter((call) => call.method === 'image').map((call) => (call.method === 'image' ? call.update.containerName : ''))).toEqual(['logos0', 'logos1']);
  });
});
