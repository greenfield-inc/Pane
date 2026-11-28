import { gzipSync } from 'zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionSnapshotService, type SessionSnapshotSources } from './sessionSnapshots';
import type { OrchestrationSessionSummary } from '../../../shared/types/orchestrationSession';
import type { AgentChatMessage } from '../../../shared/types/agentChat';
import type { SessionSnapshotHeld, SessionSnapshotsResult } from '../../../shared/types/sessionSnapshot';

/**
 * The plan's CPU budget for the sending Mac (T-116 "Budgets"): at most 1% of a core with 5 chats
 * working. Sized like the MacBook measured in T-119: 17 unarchived chat Sessions of about 100 KB
 * each (30 messages of ~3 KB), 5 of them streaming 10 updates a second for 10 seconds, and a desktop
 * that pulls after every notice, as PR 5's mirror will. Counted: watching the events, building each
 * answer, and encoding and compressing it for the wire.
 */
const SESSIONS = 17;
const WORKING = 5;
const SECONDS = 10;
const UPDATES_PER_SECOND = 10;
/** The MacBook's whole Session list: 123 records, 262 KB as a summary list (T-119). */
const LISTED = 123;
/** The plan's budget: 1% of a core. */
const BUDGET = 0.01;
/**
 * Shared CI runners (Windows above all) are slower and noisier than a developer's Mac: once at 1.1%
 * against 0.13–0.32% locally. CI still catches a regression of more than twice the budget; the
 * budget itself is asserted wherever CI isn't set.
 */
const CI_BUDGET = 0.02;

/** CPU time of this thread only where Node can tell (`threadCpuUsage`), else of this test's process. */
function cpuNow(): NodeJS.CpuUsage {
  return process.threadCpuUsage?.() ?? process.cpuUsage();
}

function chatMessage(index: number): AgentChatMessage {
  return { id: `m${index}`, role: index % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: `${index} `.padEnd(3000, 'lorem ipsum ') }] };
}

/** The text a streaming message holds so far. */
function streamed(message: AgentChatMessage): string {
  return message.parts.map(part => (part.type === 'text' ? part.text : '')).join('');
}

describe('SessionSnapshotService CPU on the host', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('stays under 1% of a core with 5 chats working', async () => {
    const conversations = new Map(Array.from({ length: SESSIONS }, (_, index) => [`chat-${index}`, Array.from({ length: 120 }, (_, message) => chatMessage(message))]));
    const records: OrchestrationSessionSummary[] = Array.from({ length: LISTED }, (_, index) => ({
      id: `s${index}`, name: `Session ${index}`, agent: 'claude', internalSessionId: `pane-${index}`,
      panelIds: { claude: `chat-${index}`, codex: `codex-${index}` },
      goal: 'g'.repeat(1000), context: 'c'.repeat(1000), decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], associations: [],
      revision: 1, createdAt: '2026-11-26T00:00:00.000Z', updatedAt: '2026-11-26T00:00:00.000Z',
    }));
    expect(JSON.stringify(records).length).toBeGreaterThan(250_000);
    const notices: Array<{ sessionId: string; revision: number }> = [];
    const sources: SessionSnapshotSources = {
      sessions: async () => structuredClone(records),
      tabs: paneId => [{ id: `chat-${paneId.slice(5)}`, sessionId: paneId, type: 'chat', title: 'Claude', state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } }],
      panel: panelId => (conversations.has(panelId) ? { id: panelId, sessionId: `pane-${panelId.slice(5)}`, type: 'chat', title: 'Claude', state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } } : undefined),
      layout: () => null,
      chat: (panelId, limit) => {
        const messages = conversations.get(panelId);
        if (!messages) return undefined;
        const window = messages.slice(-limit);
        return {
          panelId, agent: 'claude', generation: 1, status: 'working', canAttachImages: true, controls: [], commands: [], permissions: [], questions: [], queue: [],
          // The host's transcript copies its window on every read too (`structuredClone` in transcript.ts).
          transcript: { panelId, generation: 1, revision: chatRevisions.get(panelId) ?? messages.length, start: messages.length - window.length, messages: structuredClone(window) },
          messageCount: messages.length,
        };
      },
      announce: (sessionId, revision) => { notices.push({ sessionId, revision }); },
    };
    const service = new SessionSnapshotService(sources);
    const held: Record<string, SessionSnapshotHeld> = {};
    let since: number | undefined;
    let epoch: string | undefined;
    const chatRevisions = new Map<string, number>();
    let pulls = 0;
    const pull = async () => {
      pulls += 1;
      const answer: SessionSnapshotsResult = await service.snapshots({ since, epoch, held });
      since = answer.revision;
      epoch = answer.epoch;
      for (const snapshot of answer.snapshots) held[snapshot.sessionId] = { generation: 1, count: snapshot.chat.messageCount, revision: snapshot.chat.transcript!.revision };
      // The host encodes and compresses each answer for the wire (#1768).
      gzipSync(JSON.stringify(answer));
    };
    await pull();
    pulls = 0;

    const started = cpuNow();
    for (let tick = 0; tick < SECONDS * UPDATES_PER_SECOND; tick += 1) {
      const before = notices.length;
      for (let chat = 0; chat < WORKING; chat += 1) {
        const messages = conversations.get(`chat-${chat}`)!;
        // A streaming reply grows in place; every fifth update starts a new message.
        if (tick % 5 === 0) messages.push(chatMessage(messages.length));
        else {
          const last = messages.length - 1;
          messages[last] = { ...messages[last]!, parts: [{ type: 'text', text: `${streamed(messages[last]!)} more` }] };
        }
        const revision = (chatRevisions.get(`chat-${chat}`) ?? messages.length) + 1;
        chatRevisions.set(`chat-${chat}`, revision);
        service.send('chat-tab:event', { panelId: `chat-${chat}`, generation: 1, revision, index: messages.length - 1 });
      }
      await vi.advanceTimersByTimeAsync(1000 / UPDATES_PER_SECOND);
      // The worst case: a desktop that pulls once per notice (PR 5 batches them for 250 ms).
      for (let notice = before; notice < notices.length; notice += 1) await pull();
    }
    const ended = cpuNow();
    const cpuMs = (ended.user - started.user + ended.system - started.system) / 1000;
    const share = cpuMs / (SECONDS * 1000);
    process.stdout.write(`[snapshot CPU] ${SECONDS} s with ${WORKING} chats working: ${cpuMs.toFixed(1)} ms CPU (${(share * 100).toFixed(2)}% of a core), ${notices.length} notices, ${pulls} pulls\n`);

    expect(notices.length).toBeLessThanOrEqual(WORKING * (SECONDS + 1));
    expect(share).toBeLessThan(process.env.CI ? CI_BUDGET : BUDGET);
  });
});
