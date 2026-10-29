import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk';
import { describe, expect, it } from 'vitest';
import { checkPage, listItems, textContent, type Page, type TextBox } from '../src/display';
import type { Card, Computer } from '../src/model';
import {
  allClearPage,
  cardPage,
  cardRows,
  computersPage,
  connectingPage,
  dictationPage,
  firstRunPage,
  fullQuestionPage,
  homeCardPage,
  noComputerPage,
  openPanePage,
  panesPage,
  problemPage,
  refusedPage,
  keyListPage,
  keysRefusedPage,
  pickerPage,
  terminalFooter,
  terminalPage,
  voiceAnswerPage,
} from '../src/screens';
import { textWidth, utf8Length } from '../src/text';

const question: Card = {
  key: 'studio:q1', computerId: 'studio', machine: 'studio-mac', itemId: 'q1', ui: 'options', waiting: true,
  title: 'stub the clock or loosen retry?', context: 'The refresh mock returns 401 before the retry fires.',
  choices: ['Stub the clock', 'Loosen retry'], suggestions: [], paneName: 'fix-login', panelId: 'p1', createdAt: 1,
};
const longQuestion: Card = {
  ...question, key: 'studio:q2', itemId: 'q2',
  title: 'should I stub the clock in auth.spec.ts, loosen the retry window in refresh.ts to 2 s, or mock the token endpoint so it returns 200 on the second call? Stubbing is the smallest change; loosening the window changes production behavior.',
  choices: ['Stub the clock', 'Loosen retry to 2 s'],
};
const info: Card = { ...question, key: 'devbox:i1', itemId: 'i1', ui: 'info', waiting: false, title: 'PR #482 opened. Checks are running.', paneName: 'docs-pass', machine: 'devbox', choices: [] };
const computers: Computer[] = [
  { id: 'a', name: 'studio-mac', status: 'live', lastSeenAt: 0, paneCount: 5, workingCount: 1 },
  { id: 'b', name: 'laptop', status: 'offline', lastSeenAt: 1, paneCount: 0, workingCount: 0 },
];
const terminal = { kind: 'pane' as const, id: 'p', name: 'fix-login', agent: 'Claude', status: 'working' as const, panelId: 'p1' };
const position = { index: 1, total: 4, computerCount: 3 };

function texts(page: Page): string[] {
  return page.boxes.filter((box): box is TextBox => box.kind === 'text').map((box) => box.lines.join('\n'));
}

function boxNamed(page: Page, name: string) {
  const box = page.boxes.find((candidate) => candidate.name === name);
  if (!box) throw new Error(`no box ${name}`);
  return box;
}

const every: Array<[string, Page]> = [
  ['first run', firstRunPage()],
  ['home question', homeCardPage(question, position)],
  ['home info', homeCardPage(info, position)],
  ['home with confirmation', homeCardPage(info, { ...position, confirmation: 'Answered fix-login: "stub the clock, and only rerun the auth suite"' })],
  ['open a pane', openPanePage({ index: 4, total: 4, computerCount: 3 })],
  ['all clear', allClearPage(3)],
  ['card', cardPage(question, ['expected 200, got 401', 'The refresh mock returns 401 before the retry fires.'])],
  ['long card', cardPage(longQuestion, ['expected 200, got 401'])],
  ['approve card', cardPage({ ...question, ui: 'approve', title: 'the G2 remote cover sheet.' }, [])],
  ['full question', fullQuestionPage(longQuestion)],
  ['voice answer', voiceAnswerPage(question, 'stub the clock')],
  ['computers', computersPage(computers, () => '9:40')],
  ['panes', panesPage('studio-mac', [terminal])],
  ['no panes', panesPage('studio-mac', [])],
  ['terminal', terminalPage({ entry: terminal, lines: Array.from({ length: 30 }, (_, index) => `line ${index}`), scrolledUp: 0, footer: terminalFooter(question) })],
  ['terminal scrolled', terminalPage({ entry: terminal, lines: Array.from({ length: 8 }, (_, index) => `line ${index}`), scrolledUp: 4, dim: 'bottom', footer: terminalFooter(undefined) })],
  ['picker', pickerPage(terminal, ['Try the new fullscreen renderer? Flicker-free output, mouse support, selected text auto-copies.'], ['1. Yes, try it', '2. Not now'], false, terminalFooter(undefined))],
  ['key list', keyListPage(['  > 1. Yes, try it', '     2. Not now'], terminalFooter(undefined))],
  ['keys refused', keysRefusedPage(terminal, "studio-mac's Pane can't take keys from the glasses yet.", 'Update Pane on studio-mac.')],
  ['dictation', dictationPage(terminal, ['a', 'b'], 'stub the clock')],
  ['no computer', noComputerPage(3)],
  ['refused', refusedPage('devbox', { code: 'ERR_GLASSES_ORIGIN_REFUSED', message: 'This request came from https://x.example.', next: 'Allow it.' })],
  ['problem', problemPage('fix-login · studio-mac', "studio-mac can't turn speech into text.", 'Add a Deepgram key.')],
];

describe('every screen', () => {
  it.each(every)('%s fits the G2 page rules', (_name, page) => {
    expect(() => checkPage(page)).not.toThrow();
    const text = page.boxes.flatMap((box) => (box.kind === 'text' ? [{ content: textContent(box), box }] : []));
    const lists = page.boxes.flatMap((box) => (box.kind === 'list' ? [listItems(box)] : []));
    expect(validateEvenHubPageContainer({
      textObject: text.map(({ content }) => ({ content })),
      listObject: lists.map((items) => ({ itemContainer: { itemName: items } })),
    })).toEqual({ valid: true });
    for (const { content, box } of text) {
      expect(utf8Length(content)).toBeLessThanOrEqual(999);
      for (const line of box.lines) expect(textWidth(line)).toBeLessThanOrEqual(box.w);
    }
    for (const items of lists) {
      expect(items.length).toBeLessThanOrEqual(20);
      for (const item of items) expect(utf8Length(item)).toBeLessThanOrEqual(63);
    }
    for (const box of page.boxes) {
      expect(box.x + box.w).toBeLessThanOrEqual(576);
      expect(box.y + box.h).toBeLessThanOrEqual(288);
    }
  });
});

describe('home (H3)', () => {
  it('counts pages and names the kind, the Pane and the computer', () => {
    expect(texts(homeCardPage(question, position))[0]).toBe('1/4 · needs you · fix-login · studio-mac');
    expect(texts(homeCardPage(info, position))[0]).toBe('1/4 · info · docs-pass · devbox');
  });

  it('shows one all-clear page with the way into Panes when nothing waits', () => {
    const page = allClearPage(3);
    expect(texts(page)[0]).toBe('1/1 · Pane · 3 computers · all clear');
    expect(texts(page)[1]).toContain('Open a Pane…');
    expect(texts(page)[2]).toBe('press = open a Pane   double press = exit');
  });
});

describe('card (C3)', () => {
  it('keeps the choices first, then the question, with the rest for dimmed context', () => {
    const page = cardPage(question, ['expected 200, got 401', 'The refresh mock returns 401 before the retry fires.', 'third line']);
    const choices = boxNamed(page, 'choices');
    expect(choices.y).toBe(128);
    expect(choices.kind === 'list' && choices.items).toEqual(['Stub the clock', 'Loosen retry', 'Something else (hold to say it)']);
    const context = boxNamed(page, 'context');
    expect(context.kind === 'text' && context.brightness).toBeLessThan(4);
    expect(context.kind === 'text' && context.lines).toEqual(['expected 200, got 401', 'The refresh mock returns 401 before the retry fires.', 'third line']);
    expect(texts(page)).toContain('fix-login: stub the clock or loosen retry?');
  });

  it('cuts a long question at three lines and adds a row that opens the whole question', () => {
    const page = cardPage(longQuestion, ['one', 'two', 'three']);
    const asked = boxNamed(page, 'question');
    expect(asked.kind === 'text' && asked.lines.length).toBe(3);
    expect(asked.kind === 'text' && asked.lines[2]?.endsWith('…')).toBe(true);
    const context = boxNamed(page, 'context');
    expect(context.kind === 'text' && context.lines).toEqual(['three']);
    expect(cardRows(longQuestion).map((row) => row.label)).toEqual(['Stub the clock', 'Loosen retry to 2 s', 'Read the whole question', 'Something else (hold to say it)']);
  });

  it('gives an approval Approve, Not yet and a spoken reason', () => {
    expect(cardRows({ ...question, ui: 'approve' }).map((row) => row.label)).toEqual(['Approve', 'Not yet', 'Say why (hold)']);
  });
});

describe('terminal (T3)', () => {
  it('names the newest card elsewhere at full brightness, or reads "all clear elsewhere" dimmed', () => {
    expect(terminalFooter(info)).toEqual({ text: '• docs-pass: PR #482 opened. Checks are running. · double press for cards', brightness: 4 });
    expect(terminalFooter(question)).toEqual({ text: '? fix-login needs you · double press for cards', brightness: 4 });
    expect(terminalFooter(undefined).text).toBe('all clear elsewhere');
    expect(terminalFooter(undefined).brightness).toBeLessThan(4);
  });

  it('splits the page into two halves and says where the view is', () => {
    const lines = Array.from({ length: 8 }, (_, index) => `line ${index}`);
    const footer = terminalFooter(undefined);
    const live = terminalPage({ entry: terminal, lines, scrolledUp: 0, footer });
    expect(texts(live).slice(0, 3)).toEqual(['fix-login · Claude · working', 'line 0\nline 1\nline 2\nline 3', 'line 4\nline 5\nline 6\nline 7']);
    expect(texts(terminalPage({ entry: terminal, lines, scrolledUp: 40, footer }))[0]).toBe('fix-login · scrolled up 40 lines');
    expect(texts(terminalPage({ entry: terminal, lines, scrolledUp: 0, more: 18, footer }))[0]).toBe('fix-login · Claude · working · ↓ 18 more');
    expect(texts(terminalPage({ entry: terminal, lines, scrolledUp: 0, keys: true, footer }))[0]).toBe('KEYS · swipe ↑↓ · press Enter · hold Esc/Tab');
  });
});

describe('connecting', () => {
  it('names one computer in the singular', () => {
    expect(texts(connectingPage(1))[0]).toBe('Pane · 1 computer');
    expect(texts(connectingPage(3))[0]).toBe('Pane · 3 computers');
  });
});

describe('errors', () => {
  it("shows an origin refusal in the host's words, under \"Allow this app on the computer\"", () => {
    const page = refusedPage('devbox', { code: 'ERR_GLASSES_ORIGIN_REFUSED', message: 'This computer accepts glasses tokens only from the Even app; this request came from https://x.example.', next: 'Allow it in Settings › Remote Access › Glasses.' });
    expect(texts(page)[0]).toBe('devbox · not allowed');
    expect(texts(page)[1]?.replace(/\n/g, ' ')).toContain('Allow this app on the computer.');
    expect(texts(page)[1]?.replace(/\n/g, ' ')).toContain('https://x.example.');
  });

  it('waits out a lockout instead of offering a retry', () => {
    const page = refusedPage('devbox', { code: 'ERR_GLASSES_LOCKED_OUT', message: 'Ignoring it for 60 s.', retryAt: 60_000 });
    expect(texts(page).at(-1)).toBe('Pane tries again by itself   double press = back');
  });

  it('marks an offline computer and offers a retry', () => {
    const page = computersPage(computers, () => '9:40');
    const rows = page.boxes[1]?.kind === 'list' ? page.boxes[1].items : [];
    expect(rows).toEqual(['studio-mac · 5 Panes · 1 working', 'laptop · offline since 9:40 · press to retry']);
  });
});
