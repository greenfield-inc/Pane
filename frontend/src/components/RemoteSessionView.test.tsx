import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionSnapshot } from '../../../shared/types/sessionSnapshot';
import type { MachineMirrorSync } from '../../../shared/types/machineMirror';
import type { MachineState } from '../../../shared/types/machineConnections';
import type { ChatTabView } from '../../../shared/types/chatTab';
import type { OrchestrationSessionSummary } from '../../../shared/types/orchestrationSession';
import type { ToolPanel } from '../../../shared/types/panels';
import type { RemoteSessionEntry } from '../stores/remoteSessionView';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ');

const tab = (id: string, title: string, type: ToolPanel['type']): ToolPanel => ({ id, sessionId: 'pane-r', type, title, state: { isActive: false }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } });
const chat: ChatTabView = {
  panelId: 'chat-r', agent: 'claude', generation: 1, status: 'idle', canAttachImages: false, controls: [], commands: [], permissions: [], questions: [], queue: [],
  messageCount: 1,
  transcript: { panelId: 'chat-r', generation: 1, revision: 3, start: 0, messages: [{ id: 'user:1', role: 'user', parts: [{ type: 'text', text: 'ship the mirror' }] }] },
};
// SAFETY: the view reads only these record fields.
const session = { id: 's1', name: 'Mirror work', internalSessionId: 'pane-r', agent: 'claude', panelIds: { claude: 'chat-r' }, revision: 2, updatedAt: '' } as OrchestrationSessionSummary;
const snapshot: SessionSnapshot = { sessionId: 's1', revision: 4, session, chat, tabs: [tab('chat-r', 'Claude', 'chat'), tab('term-r', 'Terminal', 'terminal')], layout: null };

async function render(options: { status?: MachineState['status']; sync?: MachineMirrorSync; snapshot?: SessionSnapshot | null; read?: RemoteSessionEntry['read']; earlierBlocked?: boolean } = {}) {
  const { RemoteSessionPanel } = await import('./RemoteSessionView');
  const status = options.status ?? 'online';
  const machine: MachineState = { id: 'build', label: 'Build box', kind: 'remote', status, offlineSince: status === 'offline' ? '2026-11-26T12:05:00.000Z' : null, mine: true };
  const listing = { state: { machineId: 'build', sync: options.sync ?? 'live', lastSeenAt: '2026-11-26T12:02:00.000Z', sessionCount: 1 }, sessions: { s1: 4 } };
  return renderToStaticMarkup(<RemoteSessionPanel target={{ machineId: 'build', sessionId: 's1' }} entry={{ snapshot: options.snapshot === null ? undefined : options.snapshot ?? snapshot, read: options.read, readAt: options.read ? 1 : 0 }} listing={listing} machine={machine} row={undefined} earlierBlocked={options.earlierBlocked ?? false} />);
}

beforeEach(() => { vi.stubEnv('TZ', 'UTC'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("another machine's Session under the cursor, read-only (T-116 PR 6)", () => {
  it('names the machine, shows its tabs but not as usable, and its chat with the message box saying where typing goes', async () => {
    const html = await render();
    expect(text(html)).toContain('Mirror work');
    expect(text(html)).toContain('On Build box');
    expect(html).toMatch(/role="tab" aria-selected="true" aria-disabled="true"[^>]*>Claude</);
    expect(html).toMatch(/role="tab" aria-selected="false" aria-disabled="true"[^>]*>Terminal</);
    expect(text(html)).toContain('ship the mirror');
    expect(html).toContain('placeholder="Type to continue on Build box"');
    // It takes text: typing into it engages the Session on Build box (PR 7).
    expect(html).toMatch(/<textarea[^>]*aria-label="Message on Build box"/);
    expect(html).not.toMatch(/<textarea[^>]*readonly=""/i);
    expect(html).not.toContain('Offline');
    expect(text(html)).not.toContain('Read only: you can watch this chat');
    expect(html).not.toContain('Start a fresh conversation in this tab');
  });

  it('marks an offline machine with when it was last seen, and replaces the message box with a note', async () => {
    const html = await render({ status: 'offline' });
    expect(html).toContain('data-sync="offline"');
    expect(text(html)).toMatch(/Offline · last seen \d{2}:\d{2}/);
    expect(text(html)).toContain('Build box is offline. This is what it last sent.');
    expect(text(html)).toContain('ship the mirror');
    expect(html).not.toContain('Type to continue');
  });

  it('says so while the mirror is catching up, and keeps the content', async () => {
    const html = await render({ sync: 'catching-up' });
    expect(text(html)).toContain('Updating from Build box');
    expect(text(html)).toContain('ship the mirror');
  });

  it("says older messages load once the chat is opened there, in place of a button that can't load them (QA F-2)", async () => {
    // Its own chat: the viewer of each chat is kept per machine for the app's life.
    const later = { ...chat, panelId: 'chat-early', transcript: { ...chat.transcript!, panelId: 'chat-early', start: 550 } };
    const shown = await render({ snapshot: { ...snapshot, chat: later } });
    expect(text(shown)).toContain('Earlier messages (550)');
    const blocked = await render({ snapshot: { ...snapshot, chat: later }, earlierBlocked: true });
    expect(text(blocked)).toContain('Older messages load once this chat is opened on Build box.');
    expect(text(blocked)).not.toContain('Earlier messages');
  });

  it('says a Session the host has nothing to show of yet opens there with Enter, instead of reading forever (review suggestion)', async () => {
    const html = await render({ snapshot: null, read: { view: null, panels: [], layout: null } });
    expect(text(html)).toContain('This Session opens on Build box when you press Enter.');
    expect(text(html)).not.toContain('Reading from');
  });

  it('says a chat the host has not read since it restarted loads when opened there, instead of showing it empty', async () => {
    const html = await render({ snapshot: { ...snapshot, chat: { ...chat, transcript: undefined, messageCount: 0 }, transcriptUnknown: true } });
    expect(text(html)).toContain('Messages load when this Session is opened on Build box.');
    expect(html).not.toContain('Type to continue');
  });
});

describe("engaging another machine's Session (T-132)", () => {
  async function box(props: { held?: { text: string; send: boolean }; failure?: string; engagingCause?: 'enter' | 'type' }) {
    const { HeldComposerBox } = await import('./RemoteSessionView');
    return renderToStaticMarkup(<HeldComposerBox target={{ machineId: 'build', sessionId: 's1' }} machineName="Build box" held={props.held} failure={props.failure} engagingCause={props.engagingCause} />);
  }

  it('keeps what was typed after a failed switch, unsent, beside the reason', async () => {
    const html = await box({ held: { text: 'ship it', send: false }, failure: 'Build box stopped answering.' });
    expect(html).toMatch(/<textarea[^>]*>ship it<\/textarea>/);
    expect(html).not.toMatch(/readonly=""/i);
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain('Build box stopped answering.');
  });

  it('says a pressed Enter sends there once it opens, and holds the text still meanwhile', async () => {
    const html = await box({ held: { text: 'ship it', send: true }, engagingCause: 'enter' });
    expect(html).toMatch(/<textarea[^>]*readonly=""/i);
    expect(text(html)).toContain('Sends on Build box once it opens there.');
  });
});

describe('what was typed and not sent stays on screen (QA 1781 F-1)', () => {
  it('the kept bar shows the text, why, and that Enter sends it there', async () => {
    const { KeptBar } = await import('./RemoteSessionView');
    const html = renderToStaticMarkup(<KeptBar kept={{ machineId: 'build', sessionId: 's1', text: 'ship it', message: 'Pane daemon not running on Build box.', pending: false }} machineName="Build box" />);
    expect(text(html)).toContain('Not sent yet to Build box: Pane daemon not running on Build box.');
    expect(html).toMatch(/<textarea[^>]*aria-label="Message on Build box, not sent yet"[^>]*>ship it<\/textarea>/);
    expect(text(html)).toContain('Press Enter to send it on Build box.');
    expect(html).toContain('role="alert"');
  });

  it('a pending one says so as a status', async () => {
    const { KeptBar } = await import('./RemoteSessionView');
    const html = renderToStaticMarkup(<KeptBar kept={{ machineId: 'build', sessionId: 's1', text: 'ship it', message: 'Not sent yet: it goes into Release\'s message box on Build box once that chat opens.', pending: true }} machineName="Build box" />);
    expect(html).toContain('data-pending="true"');
    expect(html).toContain('role="status"');
  });

  it('the held view marks text as not sent yet while the link there is down', async () => {
    const { HeldComposerBox } = await import('./RemoteSessionView');
    const html = renderToStaticMarkup(<HeldComposerBox target={{ machineId: 'build', sessionId: 's1' }} machineName="Build box" held={{ text: 'ship it', send: true }} failure={undefined} engagingCause="enter" waiting />);
    expect(text(html)).toContain('Not sent yet: waiting for Build box to answer. It sends there once it does.');
    expect(html).not.toContain('remote-engage-sending');
  });
});

describe('the kept bar never promises a send its deadline has passed (review 1781 nit)', () => {
  const kept = { machineId: 'build', sessionId: 's1', text: 'ship it', message: 'Not sent yet: it goes into Release\'s message box on Build box once that chat opens.', pending: true };
  it('says it sends then while the Enter is within its 60 s', async () => {
    const { KeptBar } = await import('./RemoteSessionView');
    const html = renderToStaticMarkup(<KeptBar kept={{ ...kept, sendsBy: 2000 }} machineName="Build box" now={1000} />);
    expect(text(html)).toContain('once that chat opens. It sends then.');
  });
  it('says it goes in unsent once the 60 s have passed', async () => {
    const { KeptBar } = await import('./RemoteSessionView');
    const html = renderToStaticMarkup(<KeptBar kept={{ ...kept, sendsBy: 2000 }} machineName="Build box" now={2001} />);
    expect(text(html)).not.toContain('It sends then');
    expect(text(html)).toContain('It goes in unsent: its 60 s to send have passed.');
  });
});
