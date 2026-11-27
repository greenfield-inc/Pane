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

async function render(options: { status?: MachineState['status']; sync?: MachineMirrorSync; snapshot?: SessionSnapshot | null; read?: RemoteSessionEntry['read'] } = {}) {
  const { RemoteSessionPanel } = await import('./RemoteSessionView');
  const status = options.status ?? 'online';
  const machine: MachineState = { id: 'build', label: 'Build box', kind: 'remote', status, offlineSince: status === 'offline' ? '2026-11-26T12:05:00.000Z' : null, mine: true };
  const listing = { state: { machineId: 'build', sync: options.sync ?? 'live', lastSeenAt: '2026-11-26T12:02:00.000Z', sessionCount: 1 }, sessions: { s1: 4 } };
  return renderToStaticMarkup(<RemoteSessionPanel target={{ machineId: 'build', sessionId: 's1' }} entry={{ snapshot: options.snapshot === null ? undefined : options.snapshot ?? snapshot, read: options.read, readAt: options.read ? 1 : 0 }} listing={listing} machine={machine} row={undefined} />);
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
