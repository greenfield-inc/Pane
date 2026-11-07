import { describe, expect, it } from 'vitest';

import { decisionModel } from '@shared/autopilotDecision';
import { awayLine, awaySummary, controlLine, parseItemIds, parseLogEntries } from '@shared/autopilotTranscript';
import type { AutopilotSnapshot, AutopilotStackEntry } from '@shared/types/autopilot';
import type { NotifyItem } from '@shared/types/notify';

import {
  answerBar,
  autopilotRowState,
  autopilotUnsupported,
  cardState,
  composerPlaceholder,
  contextSource,
  docBackLabel,
  fileName,
  itemPosition,
  relatedDocs,
  startBlocked,
  walkBar,
} from './autopilot';

const entry = (id: string, notifyId: string, extra: Partial<AutopilotStackEntry> = {}): AutopilotStackEntry => ({
  id, ref: { kind: 'item', notifyId }, title: notifyId, tabs: [{ kind: 'item', label: 'Question', notifyId }], addedAt: 0, ...extra,
});

const snapshot = (extra: Partial<AutopilotSnapshot> = {}): AutopilotSnapshot => ({
  enabled: true,
  chatTabsEnabled: true,
  sentinel: false,
  entitlement: { entitled: true },
  run: { id: 'run-1', folder: '/pane/autopilot/runs/run-1', docsFolder: '/pane/autopilot/runs/run-1/docs', createdAt: '2026-11-03T09:00:00.000Z' },
  panelId: '__autopilot_panel_run-1',
  ownerPaneId: '__autopilot_owner_run-1',
  state: 'running',
  stack: { entries: [entry('e1', 'q14'), entry('e2', 'q5'), entry('e3', 'ap1', { doneAt: 5 })], shownId: 'e1' },
  walk: { sessionId: 's1', sessions: [{ id: 's1', name: 'Pane Fixes', waiting: 4 }, { id: 's2', name: 'Infra', waiting: 2 }, { id: 's3', name: 'Quiet', waiting: 0 }] },
  ...extra,
});

const item = (extra: Partial<NotifyItem> = {}): NotifyItem => ({
  id: 'q14', ui: 'options', title: 'Q-14 Approve the chat tabs plan (r7)?', state: 'waiting', createdAt: 0,
  context: 'Six packages, about 7½ weeks.',
  choices: [{ label: 'Approve', detail: 'Build starts with package 1', recommended: true }, { label: 'Request changes' }],
  source: { name: 'planner', agent: 'Claude', session: { id: 's1', name: 'Pane Fixes', paneId: 'o1', orchestrator: true } },
  ...extra,
});

describe('the chat\'s Autopilot lines', () => {
  it('reads one item id per line from an autopilot-items block, once each', () => {
    expect(parseItemIds('q14\n- q5\n\n  q14\n* ap1\n')).toEqual(['q14', 'q5', 'ap1']);
  });

  it('turns Pane\'s Start, Pause and Go on lines into notices and keeps the person\'s own words', () => {
    expect(controlLine('[Pane · Start] Read every Session…')).toBe('You pressed Start');
    expect(controlLine('  [Pane · Pause]')).toBe('You paused Autopilot');
    expect(controlLine('[Pane · Go on]')).toBe('You pressed Go on');
    expect(controlLine('Start with Infra please')).toBeUndefined();
  });
});

describe('home\'s Autopilot row', () => {
  it('offers Start before Start, then says Paused or how many are open', () => {
    expect(autopilotRowState(snapshot({ state: 'stopped' }))).toEqual({ kind: 'start' });
    expect(autopilotRowState(snapshot({ state: 'paused' }))).toEqual({ kind: 'paused' });
    expect(autopilotRowState(snapshot())).toEqual({ kind: 'open', count: 2 });
  });

  it('says why Start can\'t run and what to do', () => {
    expect(startBlocked(snapshot({ chatTabsEnabled: false }))).toMatch(/Turn on Chat tabs/);
    expect(startBlocked(snapshot({ entitlement: { entitled: false, reason: 'Autopilot is a paid feature.', next: 'Upgrade.' } }))).toBe('Autopilot is a paid feature. Upgrade.');
    expect(autopilotRowState(snapshot({ state: 'stopped', chatTabsEnabled: false })).kind).toBe('start');
    expect(startBlocked(snapshot())).toBeUndefined();
  });

  it('hides the row on a computer whose Pane predates Autopilot', () => {
    expect(autopilotUnsupported(new Error('No Pane daemon command registered for autopilot:snapshot'))).toBe(true);
    expect(autopilotUnsupported(new Error('Network down'))).toBe(false);
    expect(autopilotUnsupported(null)).toBe(false);
  });
});

describe('the walk bar', () => {
  it('lists Sessions with something waiting, the current one marked, and skips quiet ones', () => {
    expect(walkBar(snapshot())).toEqual({ status: 'Running', chips: [
      { id: 's1', name: 'Pane Fixes', waiting: 4, current: true },
      { id: 's2', name: 'Infra', waiting: 2, current: false },
    ] });
    expect(walkBar(snapshot({ state: 'paused' })).status).toBe('Paused');
    expect(walkBar(snapshot({ sentinel: true })).status).toBe('Sentinel');
  });
});

describe('the approval full screen', () => {
  it('counts the items Autopilot put on the stack, and falls back to Approvals\' order', () => {
    expect(itemPosition(snapshot(), 'q5', [])).toBe('2 of 3');
    expect(itemPosition(snapshot(), 'other', ['a', 'other'])).toBe('2 of 2');
    expect(itemPosition(undefined, 'missing', [])).toBeNull();
  });

  it('lists the item\'s links then its stack entry\'s files and pages, each once', () => {
    const docs = relatedDocs(item({ links: [
      { label: 'cover-sheet.html', path: '/repo/tmp/plan/cover-sheet.html' },
      { label: 'Test build', url: 'http://localhost:5173/' },
    ] }), entry('e1', 'q14', { tabs: [
      { kind: 'item', label: 'Question', notifyId: 'q14' },
      { kind: 'file', label: 'cover-sheet.html', path: '/repo/tmp/plan/cover-sheet.html' },
      { kind: 'file', label: 'mock-ups r2', path: '/repo/tmp/plan/shots/home.png' },
      { kind: 'session', label: 'Overview', sessionId: 's1' },
    ] }));
    expect(docs.map(doc => [doc.label, doc.icon, doc.detail])).toEqual([
      ['cover-sheet.html', 'file', 'repo/tmp/plan'],
      ['Test build', 'globe', 'localhost:5173'],
      ['mock-ups r2', 'image', 'tmp/plan/shots'],
    ]);
  });

  it('labels the context by who wrote it, and the document\'s back button by the Q-n', () => {
    expect(contextSource(decisionModel(item()))).toBe('from orchestrator');
    const own = decisionModel(item({ source: { name: 'Autopilot', agent: 'Claude', autopilot: true }, title: 'Close out finished work?' }));
    expect(contextSource(own)).toBe('written by Autopilot');
    expect(docBackLabel(decisionModel(item()))).toBe('Q-14');
    expect(docBackLabel(own)).toBe('Autopilot');
    expect(fileName('/pane/autopilot/runs/1/docs/close-out.html')).toBe('close-out.html');
  });

  it('puts two options in the bottom bar, asks to pick from more, and takes text for an open question', () => {
    expect(answerBar(decisionModel(item()), { kind: 'open' })).toBe('buttons');
    const three = item({ choices: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] });
    expect(answerBar(decisionModel(three), { kind: 'open' })).toBe('pick');
    expect(answerBar(decisionModel(item({ ui: 'ask', choices: undefined })), { kind: 'open' })).toBe('text');
    expect(answerBar(decisionModel(item({ state: 'answered' })), cardState(item({ state: 'answered' })))).toBe('none');
  });
});

describe('a card\'s state', () => {
  it('shows an answer held for Undo, then who recorded it', () => {
    expect(cardState(item({ state: 'sent', answerSummary: 'Approve' }))).toEqual({ kind: 'held', answer: 'Approve' });
    expect(cardState(item({ state: 'answered', answerSummary: 'Approve' }))).toEqual({ kind: 'answered', answer: 'Approve', recorded: 'by you · Pane Fixes recorded it' });
    expect(cardState(item({ state: 'answered', source: { name: 'Autopilot', agent: 'Claude', autopilot: true } }))).toMatchObject({ recorded: 'by you · Autopilot recorded it' });
  });

  it('takes no answer for a stuck worker\'s question, a prompt only the terminal can answer, or a gone item', () => {
    expect(cardState(item({ relay: { inboxItemId: 'i1', worker: 'csv-export', question: 'Which delimiter?' } }))).toMatchObject({ kind: 'closed', message: expect.stringContaining('Pane Fixes orchestrator') });
    expect(cardState(item({ agentPrompt: { yes: '1', no: '3', inTerminal: true } }))).toMatchObject({ kind: 'closed' });
    expect(cardState(item({ state: 'expired' }))).toEqual({ kind: 'closed', message: 'Claude stopped waiting.' });
    expect(cardState(undefined)).toEqual({ kind: 'closed', message: 'No longer waiting.' });
    expect(cardState(item())).toEqual({ kind: 'open' });
  });
});

describe('the composer hint', () => {
  it('asks about the item on screen while it waits, else messages Autopilot', () => {
    expect(composerPlaceholder(snapshot(), [item()], decisionModel)).toBe('Ask about Q-14…');
    expect(composerPlaceholder(snapshot(), [item({ state: 'answered' })], decisionModel)).toBe('Message Autopilot…');
    expect(composerPlaceholder(undefined, [], decisionModel)).toBe('Message Autopilot…');
  });
});

describe('Sentinel on the phone', () => {
  const away = [
    '{"summary":{"from":"09:58","to":"12:08","log":"/pane/autopilot/runs/1/docs/away-log.html"}}',
    '{"at":"10:12","session":"Pane Fixes","kind":"answered","what":"Keep #1215\'s prompts? -> yes","why":"D-21 in the cover sheet"}',
    'not json',
    '{"at":"10:38","session":"Infra","kind":"nudged","what":"orchestrator idle 25 min"}',
    '{"at":"11:02","session":"Infra","kind":"wrong"}',
  ].join('\n');

  it('reads Sentinel\'s calls one line each, skipping lines that aren\'t one', () => {
    expect(parseLogEntries(away)).toEqual([
      { at: '10:12', session: 'Pane Fixes', kind: 'answered', what: 'Keep #1215\'s prompts? -> yes', why: 'D-21 in the cover sheet' },
      { at: '10:38', session: 'Infra', kind: 'nudged', what: 'orchestrator idle 25 min' },
    ]);
  });

  it('sums up the time away and points at the away log', () => {
    expect(awaySummary(away)).toEqual({ from: '09:58', to: '12:08', log: '/pane/autopilot/runs/1/docs/away-log.html' });
    expect(awayLine(away)).toBe('09:58–12:08 · 1 answered · 1 nudged · 0 sent to you');
    expect(awayLine('')).toBe('0 answered · 0 nudged · 0 sent to you');
  });

  it('shows Sentinel on and off as notices and hides its 5-minute check', () => {
    expect(controlLine('[Pane · Sentinel on] Keep Sessions moving.')).toBe('Sentinel on');
    expect(controlLine('[Pane · Sentinel off]')).toBe('Sentinel off · welcome back');
    expect(controlLine('[Pane · Sentinel check]')).toBe('');
    expect(controlLine('[Pane · Back] The person opened Autopilot while Sentinel stays on.')).toBe('Welcome back');
  });

  it('says Sentinel on home\'s row while it runs', () => {
    expect(autopilotRowState(snapshot({ sentinel: true }))).toEqual({ kind: 'sentinel' });
    expect(autopilotRowState(snapshot({ sentinel: true, state: 'stopped' })).kind).toBe('start');
  });
});

