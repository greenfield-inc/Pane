import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { dismissDialogs, launchIsolated, type IsolatedPane } from './isolatedPane';

/**
 * Chat Sessions with long, realistic histories for timing journeys (T-87, T-116): each is a
 * Claude Session whose chat runs the scripted ACP agent, with its stored history rewritten.
 */

const SCRIPTED_AGENT = path.resolve('main/src/services/chatTabs/testing/scriptedAgent.mjs');

/** The text the last message of a seeded Session ends with, so a journey can see it on screen. */
export const endMark = (name: string) => `END-MARK-${name}`;

/** ACP updates the scripted agent replays on session/load: a long, realistic conversation. */
function conversation(turns: number, mark: string): unknown[] {
  const updates: unknown[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const feature = `feature${turn % 11}`;
    updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `Turn ${turn}: please look at module ${turn % 37} and fix the failing test in \`src/${feature}.ts\`. Keep the API stable.` } });
    for (const [kind, title] of [['read', `Read src/${feature}.ts`], ['execute', `pnpm vitest run src/${feature}.test.ts`]] as const) {
      const toolCallId = `tool-${randomUUID()}`;
      const output = Array.from({ length: 12 }, (_, line) => `${line + 1}  const value${line} = compute(${line}, options); // output line ${line}`).join('\n');
      updates.push({ sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'in_progress', rawInput: kind === 'execute' ? { command: title } : { file_path: title.slice(5) } });
      updates.push({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }] });
    }
    const text = [
      `I found the problem in **${feature}**. The test failed because \`compute\` returned a stale value after the cache was cleared.`,
      '',
      '- The cache key ignored `options.locale`.',
      '- `reset()` cleared the map but not the pending promise.',
      '- The test relied on timer order.',
      '',
      '```ts',
      `export function compute${turn}(input: number, options: Options): number {`,
      '  const key = `${input}:${options.locale}`;',
      '  const cached = cache.get(key);',
      '  if (cached !== undefined) return cached;',
      '  const value = expensive(input, options);',
      '  cache.set(key, value);',
      '  return value;',
      '}',
      '```',
      '',
      `Tests pass now (${(turn % 50) + 3} passed). ${turn === turns - 1 ? mark : ''}`,
    ].join('\n');
    updates.push({ sessionUpdate: 'agent_message_chunk', messageId: randomUUID(), content: { type: 'text', text } });
  }
  return updates;
}

/** A `claude` stand-in on PATH, so creating a Claude Session never runs a real one. */
export function withFakeClaude(pane: IsolatedPane): void {
  const bin = path.join(pane.root, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.999 (Claude Code)"; exit 0; fi\necho "stand-in claude"\nexit 1\n');
  chmodSync(path.join(bin, 'claude'), 0o755);
  pane.env.PATH = `${bin}${path.delimiter}${pane.env.PATH}`;
}

/** Launches an isolated Pane whose chats run the scripted agent, past its first-run dialogs. */
export async function launchWithScriptedAgent(pane: IsolatedPane, baseURL: string | undefined): Promise<{ app: ElectronApplication; page: Page }> {
  const launched = await launchIsolated(pane, baseURL, { PANE_CHAT_TEST_AGENT: SCRIPTED_AGENT });
  await dismissDialogs(launched.page);
  return launched;
}

export interface SeededChat { name: string; id: string; panelId: string; turns: number; messages: number }

/**
 * Creates one chat Session per entry (each turn is 4 messages), then closes the app and rewrites
 * each scripted agent's stored history so the next launch replays `turns` turns ending in endMark.
 */
export async function seedChatSessions(pane: IsolatedPane, baseURL: string | undefined, plan: Array<{ name: string; turns: number }>): Promise<SeededChat[]> {
  const store = path.join(pane.paneDir, 'scripted-agent');
  const listStore = () => (existsSync(store) ? readdirSync(store) : []);
  const sessions: Array<SeededChat & { acp: string }> = [];
  const { app, page } = await launchWithScriptedAgent(pane, baseURL);
  try {
    await page.evaluate(async () => { await window.electronAPI.config.update({ chatTabsEnabled: true }); });
    for (const { name, turns } of plan) {
      const before = new Set(listStore());
      const view = await page.evaluate(async sessionName => {
        const result = await window.electronAPI.orchestrationSessions.create({ name: sessionName, agent: 'claude' });
        // SAFETY: orchestration-sessions:create returns an OrchestrationSessionView in `data` when it succeeds.
        const data = result.data as { session: { id: string }; panel: { id: string } } | undefined;
        if (!data) throw new Error(`Creating Session ${sessionName} failed: ${JSON.stringify(result)}`);
        return { id: data.session.id, panelId: data.panel.id };
      }, name);
      const fresh = () => listStore().filter(file => !before.has(file));
      // The chat's agent starts with the Session, or else once the Session is shown.
      await expect.poll(() => fresh().length, { timeout: 8_000 }).toBeGreaterThan(0).catch(async () => {
        await page.getByTestId(`orchestration-session-${view.id}`).click();
        await expect.poll(() => fresh().length, { timeout: 20_000 }).toBeGreaterThan(0);
      });
      expect(fresh(), `one scripted-agent store for ${name}`).toHaveLength(1);
      sessions.push({ name, ...view, turns, messages: turns * 4, acp: fresh()[0].replace(/\.json$/, '') });
    }
  } finally {
    await app.close().catch(() => undefined);
  }
  for (const session of sessions) {
    const file = path.join(store, `${session.acp}.json`);
    const saved: { updates?: unknown[] } = JSON.parse(readFileSync(file, 'utf8'));
    saved.updates = conversation(session.turns, endMark(session.name));
    writeFileSync(file, JSON.stringify(saved));
  }
  return sessions.map(({ acp: _acp, ...session }) => session);
}
