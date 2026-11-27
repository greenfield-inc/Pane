import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchDraft } from './launchOutline';

async function shownError() {
  const { useErrorStore } = await import('../stores/errorStore');
  return useErrorStore.getState().currentError;
}

const draft = (text: string, extra: Partial<LaunchDraft> = {}): LaunchDraft => ({ text, selectionStart: text.length, selectionEnd: text.length, focused: false, send: false, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-27T10:00:00.000Z'));
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('chat draft handover (T-132, review 1781 SF-4)', () => {
  it('keeps one waiting handover per chat tab: a newer one for another tab drops none', async () => {
    const { acceptChatDraft, handOverChatDraft } = await import('./chatDraftHandover');
    handOverChatDraft('panel-a', draft('for a'));
    handOverChatDraft('panel-b', draft('for b'));
    const takenA: string[] = [];
    const takenB: string[] = [];
    acceptChatDraft('panel-a', taken => takenA.push(taken.text))();
    acceptChatDraft('panel-b', taken => takenB.push(taken.text))();
    expect(takenA).toEqual(['for a']);
    expect(takenB).toEqual(['for b']);
  });

  it('an Enter waits with an absolute deadline: a chat that mounts after it takes the text, past its deadline, and does not send', async () => {
    const { acceptChatDraft, handOverChatDraft, sendDeadline } = await import('./chatDraftHandover');
    handOverChatDraft('panel-a', draft('ship it', { send: true, sendBy: Date.now() + 60_000 }));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const taken: LaunchDraft[] = [];
    acceptChatDraft('panel-a', item => taken.push(item));
    expect(taken).toHaveLength(1);
    expect(sendDeadline(taken[0], 5000)).toBeLessThan(Date.now());
  });

  it('tells the person when an Enter waiting for its chat expires unsent, and the text is kept', async () => {
    const { acceptChatDraft, handOverChatDraft } = await import('./chatDraftHandover');
    handOverChatDraft('panel-a', draft('ship it', { send: true, sendBy: Date.now() + 60_000 }));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(await shownError()).toBeNull();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(JSON.stringify(await shownError())).toMatch(/not sent/i);
    const taken: string[] = [];
    acceptChatDraft('panel-a', item => taken.push(item.text));
    expect(taken).toEqual(['ship it']);
  });

  it('a chat that takes the Enter in time says nothing, and the deadline is the one handed over', async () => {
    const { acceptChatDraft, handOverChatDraft, sendDeadline } = await import('./chatDraftHandover');
    const sendBy = Date.now() + 60_000;
    handOverChatDraft('panel-a', draft('ship it', { send: true, sendBy }));
    await vi.advanceTimersByTimeAsync(1000);
    const taken: LaunchDraft[] = [];
    acceptChatDraft('panel-a', item => taken.push(item));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await shownError()).toBeNull();
    expect(sendDeadline(taken[0], 5000)).toBe(sendBy);
    // The launch outline's own Enter has no deadline of its own: the default from now.
    expect(sendDeadline(draft('x', { send: true }), 5000)).toBe(Date.now() + 5000);
  });
});

describe('a handed-over Enter waits for the window\'s link (QA 1781 F-1)', () => {
  it('waits while the link is down or the chat cannot send, sends once both are ready, and gives up past its deadline', async () => {
    const { pendingSendStep } = await import('./chatDraftHandover');
    const pending = { until: 1000 };
    expect(pendingSendStep(pending, { edited: false, now: 500, sendDisabled: false, linkUp: false })).toBe('wait');
    expect(pendingSendStep(pending, { edited: false, now: 500, sendDisabled: true, linkUp: true })).toBe('wait');
    expect(pendingSendStep(pending, { edited: false, now: 500, sendDisabled: false, linkUp: true })).toBe('send');
    expect(pendingSendStep(pending, { edited: false, now: 1001, sendDisabled: false, linkUp: true })).toBe('expired');
    expect(pendingSendStep(pending, { edited: true, now: 500, sendDisabled: false, linkUp: true })).toBe('edited');
  });
});

describe('the note beside a handed-over text (QA 1781 F-2, D-22)', () => {
  it('stays while the box holds that text and goes once it is edited or sent', async () => {
    const { draftNoteStays } = await import('./chatDraftHandover');
    expect(draftNoteStays({ text: 'ship it' }, 'ship it')).toBe(true);
    expect(draftNoteStays({ text: 'ship it' }, 'ship it now')).toBe(false);
    expect(draftNoteStays({ text: 'ship it' }, '')).toBe(false);
  });
});

describe('the note beside a handed-over text outlives a remount of its chat (review 1781 round 4)', () => {
  it('is remembered per chat tab until it is cleared', async () => {
    const { rememberDraftNote, rememberedDraftNote } = await import('./chatDraftHandover');
    const note = { text: 'ship it', note: 'Not sent: Build box didn\'t answer within a minute. Press Enter to send.' };
    rememberDraftNote('panel-a', note);
    expect(rememberedDraftNote('panel-a')).toEqual(note);
    expect(rememberedDraftNote('panel-b')).toBeNull();
    rememberDraftNote('panel-a', null);
    expect(rememberedDraftNote('panel-a')).toBeNull();
  });
});
