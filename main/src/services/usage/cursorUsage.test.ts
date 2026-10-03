import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import {
  cursorCliWorkspaceHash,
  listPaneCursorChats,
  loadCursorWindow,
  mapCursorPeriodLimits,
  normalizeCursorModelId,
  parseFilteredUsageEvents,
  selectPaneCursorEvents,
} from './cursorUsage';

const CHAT_ID = '8ff011fb-7f01-4e74-bbe1-e026d47ea50f';
const OTHER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function jsonResponse(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('normalizeCursorModelId', () => {
  it('turns Cursor display names into price-table ids', () => {
    expect(normalizeCursorModelId('Composer 2.5 (Fast)')).toBe('composer-2.5-fast');
    expect(normalizeCursorModelId('Grok 4.7 500k (Fast)')).toBe('grok-4.7-500k-fast');
    expect(normalizeCursorModelId('composer-2.5')).toBe('composer-2.5');
    expect(normalizeCursorModelId('cursor-grok-4.6-high-fast')).toBe('grok-4.6-fast');
    expect(normalizeCursorModelId('grok-4.7-high-fast')).toBe('grok-4.7-fast');
    expect(normalizeCursorModelId('gpt-5.6-sol-medium')).toBe('gpt-5.6-sol');
  });
});

describe('selectPaneCursorEvents', () => {
  it('drops conversations Pane did not capture and keeps the Pane worktree', () => {
    const events = parseFilteredUsageEvents({
      usageEventsDisplay: [
        {
          timestamp: '1783591555915',
          model: 'Composer 2.5',
          conversationId: CHAT_ID,
          tokenUsage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 2 },
        },
        {
          timestamp: '1783591555915',
          model: 'composer-2.5',
          conversationId: OTHER_ID,
          tokenUsage: { inputTokens: 99, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
        {
          timestamp: '1783591556000',
          model: 'composer-2.5',
          conversationId: CHAT_ID,
          tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      ],
    });

    expect(selectPaneCursorEvents(events, [{ chatId: CHAT_ID, cwd: '/work/pane' }])).toEqual([
      expect.objectContaining({
        provider: 'cursor',
        model: 'composer-2.5',
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 1,
        cacheCreationTokens: 2,
        agentSessionId: CHAT_ID,
        cwd: '/work/pane',
      }),
    ]);
  });
});

describe('mapCursorPeriodLimits', () => {
  it('maps Auto and API percents onto the two limit slots', () => {
    const limits = mapCursorPeriodLimits({
      billingCycleStart: '1000000000000',
      billingCycleEnd: '1000000000000',
      planUsage: { autoPercentUsed: 12.5, apiPercentUsed: 40 },
    }, 'pro', 1000000001000);

    expect(limits.map(limit => [limit.limitId, limit.scope, limit.usedPercent, limit.limitName])).toEqual([
      ['auto', 'primary', 12.5, 'Auto'],
      ['api', 'secondary', 40, 'API'],
    ]);
    expect(limits[0]?.planType).toBe('pro');
  });
});

describe('listPaneCursorChats', () => {
  it('reads captured Cursor chat ids, including archived Panes', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        worktree_path TEXT NOT NULL,
        archived INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tool_panels (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        state TEXT
      );
    `);
    db.prepare('INSERT INTO sessions (id, worktree_path, archived, updated_at) VALUES (?, ?, ?, ?)').run(
      'pane-1', '/work/pane', 1, '2026-10-03 00:00:00',
    );
    db.prepare('INSERT INTO tool_panels (id, session_id, state) VALUES (?, ?, ?)').run(
      'panel-1',
      'pane-1',
      JSON.stringify({ customState: { agentType: 'cursor', agentSessionId: CHAT_ID } }),
    );
    db.prepare('INSERT INTO tool_panels (id, session_id, state) VALUES (?, ?, ?)').run(
      'panel-2',
      'pane-1',
      JSON.stringify({ customState: { agentType: 'claude', agentSessionId: OTHER_ID } }),
    );

    expect(listPaneCursorChats(db, join(tmpdir(), 'pane-cursor-chats-missing'))).toEqual([
      { chatId: CHAT_ID, cwd: '/work/pane' },
    ]);
  });

  it('includes Cursor CLI chats stored for a Pane worktree', () => {
    const chatsRoot = mkdtempSync(join(tmpdir(), 'pane-cursor-chats-'));
    const cwd = '/work/cli-pane';
    const cliChatId = '11111111-2222-4333-8444-555555555555';
    mkdirSync(join(chatsRoot, cursorCliWorkspaceHash(cwd), cliChatId), { recursive: true });
    mkdirSync(join(chatsRoot, cursorCliWorkspaceHash(cwd), 'not-a-chat'));

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        worktree_path TEXT NOT NULL,
        archived INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tool_panels (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        state TEXT
      );
    `);
    db.prepare('INSERT INTO sessions (id, worktree_path, archived, updated_at) VALUES (?, ?, ?, ?)').run(
      'pane-1', cwd, 0, '2026-10-03 00:00:00',
    );

    expect(listPaneCursorChats(db, chatsRoot)).toEqual([{ chatId: cliChatId, cwd }]);
  });
});

describe('loadCursorWindow', () => {
  it('stops after a short page and returns unauthorized without indexing', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('GetCurrentPeriodUsage')) {
        return jsonResponse({ planUsage: { autoPercentUsed: 1, apiPercentUsed: 2 } });
      }
      return jsonResponse({
        usageEventsDisplay: [{
          timestamp: '1783591555915',
          model: 'composer-2.5',
          conversationId: CHAT_ID,
          tokenUsage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }],
      });
    };

    const loaded = await loadCursorWindow('token', 1, 2, fetchImpl);
    expect(loaded.status).toBe('ok');
    if (loaded.status === 'ok') expect(loaded.window.events).toHaveLength(1);

    const denied: typeof fetch = async () => jsonResponse({ error: 'nope' }, 401);
    expect((await loadCursorWindow('token', 1, 2, denied)).status).toBe('unauthorized');
  });

  it('reads the next page when a full page contains rows with no tokens', async () => {
    const fullPage = Array.from({ length: 500 }, (_, index) => ({
      timestamp: String(1_783_591_555_915 + index),
      model: 'composer-2.5',
      conversationId: OTHER_ID,
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));
    let eventPages = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('GetCurrentPeriodUsage')) {
        return jsonResponse({ planUsage: { autoPercentUsed: 1, apiPercentUsed: 2 } });
      }
      eventPages += 1;
      if (eventPages === 1) return jsonResponse({ usageEventsDisplay: fullPage });
      return jsonResponse({
        usageEventsDisplay: [{
          timestamp: '1783591557000',
          model: 'composer-2.5',
          conversationId: CHAT_ID,
          tokenUsage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }],
      });
    };

    const loaded = await loadCursorWindow('token', 1, 2, fetchImpl);
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;
    expect(eventPages).toBe(2);
    expect(loaded.window.events.map(event => event.conversationId)).toEqual([CHAT_ID]);
  });
});
