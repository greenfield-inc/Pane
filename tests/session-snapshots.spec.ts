import { expect, test } from '@playwright/test';
import net from 'node:net';
import path from 'node:path';
import { getPaneDaemonEndpoint } from '../main/src/daemon/socketPath';
import { PaneDaemonFrameDecoder, encodePaneDaemonFrame } from '../main/src/daemon/socketFraming';
import type { PaneDaemonEventFrame, PaneDaemonResponseFrame } from '../shared/types/daemon';
import { boundary, decodeBoundary, type JsonValue } from '../shared/validation/boundaryDecoder';
import { dismissDialogs, isolatedPane, launchIsolated } from './isolatedPane';
import { SESSION_SNAPSHOT_CHANGED_CHANNEL, SESSION_SNAPSHOTS_CHANNEL, type SessionSnapshotsRequest, type SessionSnapshotsResult } from '../shared/types/sessionSnapshot';

// Host snapshots (T-116 PR 4) in a real, isolated Pane: `orchestration-sessions:snapshots` answers
// with each chat Session's summary, tabs, layout and newest messages, a new message raises its
// revision and sends `session-snapshot:changed`, and a read with `since` and `held` sends only what
// changed. The chat runs the scripted ACP agent, so no real agent or account is touched. Asked over
// the local daemon socket; the owner-only refusal of remote callers is covered by unit tests.

const AGENT = path.resolve('main/src/services/chatTabs/testing/scriptedAgent.mjs');

/** A connection to the isolated Pane's daemon socket that sends requests and keeps the events it asked for. */
function daemon(paneDir: string, events: string[]) {
  const socket = net.createConnection(getPaneDaemonEndpoint(paneDir).path);
  const decoder = new PaneDaemonFrameDecoder();
  const pending = new Map<number, (frame: PaneDaemonResponseFrame) => void>();
  const received: PaneDaemonEventFrame[] = [];
  let nextId = 1;
  socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.type === 'event') received.push(frame);
      if (frame.type !== 'response') continue;
      pending.get(frame.id)?.(frame);
      pending.delete(frame.id);
    }
  });
  const request = (channel: string, args: JsonValue[]) => new Promise<JsonValue | undefined>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, frame => (frame.ok ? resolve(frame.result) : reject(new Error(frame.error.message))));
    socket.write(encodePaneDaemonFrame({ type: 'request', id, channel, args }));
  });
  socket.write(encodePaneDaemonFrame({ type: 'request', id: 0, channel: 'daemon:events', args: [{ include: events }] }));
  return { request, received, close: () => socket.destroy() };
}

async function snapshots(client: ReturnType<typeof daemon>, request: SessionSnapshotsRequest): Promise<SessionSnapshotsResult> {
  const answer = decodeBoundary(await client.request(SESSION_SNAPSHOTS_CHANNEL, [toJson(request)]), boundary.object({
    success: boundary.boolean, data: boundary.optional(boundary.json), error: boundary.optional(boundary.string),
  }));
  if (!answer.success || !answer.data) throw new Error(`snapshots failed: ${answer.error}`);
  // SAFETY: a successful snapshots answer's data is a SessionSnapshotsResult (main/src/services/sessionSnapshots.ts).
  return answer.data as SessionSnapshotsResult;
}

function toJson(request: SessionSnapshotsRequest): JsonValue {
  return decodeBoundary(JSON.parse(JSON.stringify(request)), boundary.json);
}

test('a chat Session\'s host snapshot holds its newest messages and announces each change', async ({ baseURL }) => {
  test.setTimeout(120_000);
  const pane = isolatedPane('pane-session-snapshots');
  const { app, page } = await launchIsolated(pane, baseURL, { PANE_CHAT_TEST_AGENT: AGENT });
  const client = daemon(pane.paneDir, [SESSION_SNAPSHOT_CHANGED_CHANNEL]);
  try {
    await page.evaluate(async () => { await window.electronAPI.config.update({ chatTabsEnabled: true }); });
    await dismissDialogs(page);
    const session = await page.evaluate(async () => {
      const result = await window.electronAPI.orchestrationSessions.create({ name: 'Snapshot journey', agent: 'claude' });
      // SAFETY: orchestration-sessions:create returns an OrchestrationSessionView in `data` when it succeeds.
      const view = result.data as { session: { id: string; internalSessionId: string }; panel: { id: string } };
      return { id: view.session.id, paneId: view.session.internalSessionId, panelId: view.panel.id };
    });
    await expect.poll(() => page.evaluate(async id => (await window.electronAPI.chatTab.get(id)).status, session.panelId), { timeout: 30_000 }).toBe('idle');

    const first = await snapshots(client, {});
    expect(first.sessionIds).toContain(session.id);
    const snapshot = first.snapshots.find(entry => entry.sessionId === session.id)!;
    expect(snapshot.session.name).toBe('Snapshot journey');
    expect(snapshot.session).not.toHaveProperty('activity');
    expect(snapshot.chat.panelId).toBe(session.panelId);
    expect(snapshot.tabs.map(tab => tab.id)).toContain(session.panelId);
    const tabsBefore = snapshot.tabs.length;

    // A message with a large image: the reply arrives, the revision rises and a notice says so.
    const image = Buffer.alloc(60_000, 7).toString('base64');
    await page.evaluate(async ({ panelId, data }) => {
      await window.electronAPI.chatTab.send(panelId, { operationId: 'snapshot-1', text: 'hello snapshots', images: [{ mimeType: 'image/png', data }] });
    }, { panelId: session.panelId, data: image });
    let latest = first;
    await expect.poll(async () => {
      latest = await snapshots(client, { since: first.revision });
      const texts = JSON.stringify(latest.snapshots.find(entry => entry.sessionId === session.id)?.chat.transcript?.messages ?? []);
      return texts.includes('You said: hello snapshots');
    }, { timeout: 30_000 }).toBe(true);
    const changed = latest.snapshots.find(entry => entry.sessionId === session.id)!;
    expect(changed.revision).toBeGreaterThan(first.revision);
    expect(JSON.stringify(changed)).not.toContain(image);
    const notice = boundary.object({ sessionId: boundary.string, revision: boundary.number });
    await expect.poll(() => client.received
      .filter(event => event.channel === SESSION_SNAPSHOT_CHANGED_CHANNEL)
      .some(event => decodeBoundary(event.args[0], notice).sessionId === session.id), { timeout: 5_000 }).toBe(true);

    // A desktop that holds those messages gets only the last one again, and no Session that did not change.
    const count = changed.chat.messageCount;
    // Once the reply has settled, a read since the last one sends nothing.
    let since = latest.revision;
    await expect.poll(async () => {
      const next = await snapshots(client, { since });
      since = next.revision;
      return next.snapshots.length;
    }, { timeout: 10_000, intervals: [1_500] }).toBe(0);
    const held = await snapshots(client, { held: { [session.id]: { generation: changed.chat.generation, count } } });
    const again = held.snapshots.find(entry => entry.sessionId === session.id)!;
    expect(again.chat.transcript?.start).toBe(count - 1);
    expect(again.chat.transcript?.messages).toHaveLength(1);
    // Reading created no tab.
    expect(again.tabs).toHaveLength(tabsBefore);
  } finally {
    client.close();
    await app.close();
  }
});
