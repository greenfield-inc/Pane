import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentMessageRecord, RunpaneMessageShowResult, RunpaneMessageWaitResult, RunpaneReplyResult } from '../shared/types/agentMessages';
import { createSession, json, setup, shot, transcript, type SessionRef } from './todosHarness';

// Agent-to-agent messages (T-104) in a real, isolated Pane (D-288). Both Sessions' orchestrators are chat tabs
// running the scripted ACP agent, which echoes what it is sent; each runpane call runs as one of those tabs.

interface SubmitResult { ok: boolean; messageId?: string }

const caller = (session: SessionRef) => ({ paneId: session.paneId, panelId: session.panelId });

/** Opens a Session's chat and captures it, with the runpane output beside it, when TODOS_SHOTS_DIR names a folder. */
async function evidence(page: Page, session: SessionRef, name: string, text: string): Promise<void> {
  const folder = process.env.TODOS_SHOTS_DIR;
  if (!folder) return;
  await page.getByTestId(`orchestration-session-${session.id}`).click();
  await page.waitForTimeout(1_000);
  await shot(page, name);
  writeFileSync(path.join(folder, `${name}.txt`), text);
}

async function forPanel(page: Page, panelId: string): Promise<AgentMessageRecord[]> {
  return page.evaluate(async id => {
    const response = await window.electronAPI.agentMessages.forPanel(id);
    if (!response.success || !response.data) throw new Error(response.error ?? 'no messages');
    return response.data;
  }, panelId);
}

test('an agent asks another Session, gets its runpane reply in its own tab, after a restart, and with --await-reply (T-104)', async ({ baseURL }) => {
  test.setTimeout(240_000);
  const { pane, page, close } = await setup('pane-agent-messages', { VITE_PORT: new URL(baseURL ?? 'http://localhost:4521').port });
  try {
    const omni = await createSession(page, 'Omni Chat');
    const billing = await createSession(page, 'Billing');
    const ask = (text: string, extra: string[] = []) => json<SubmitResult>(pane, ['panels', 'submit', '--panel', billing.panelId, '--text', text, '--no-expect-report', '--yes', ...extra], caller(omni));

    // A's message to B gets M-1 and a reply line; B's tab shows both.
    const sent = await ask('[From the "Omni Chat" Session orchestrator] Is the billing API frozen?');
    expect(sent).toMatchObject({ ok: true, messageId: 'M-1' });
    await expect.poll(() => transcript(page, billing.panelId), { timeout: 30_000 })
      .toContain('Reply with runpane reply M-1 \\"…\\": it reaches the \\"Omni Chat\\" Session orchestrator, who never sees your own chat.');
    await evidence(page, billing, '01-message-with-reply-line', `panels submit (as Omni Chat) → ${JSON.stringify(sent)}\n`);

    // The person's text (no calling tab, or --source user) goes as typed, with no id.
    expect((await json<SubmitResult>(pane, ['panels', 'submit', '--panel', billing.panelId, '--text', 'typed by the person', '--source', 'user', '--yes'])).messageId).toBeUndefined();
    expect((await json<SubmitResult>(pane, ['panels', 'submit', '--panel', billing.panelId, '--text', 'also the person', '--source', 'user', '--no-expect-report', '--yes'], caller(omni))).messageId).toBeUndefined();

    // B replies; it lands in A's tab naming the original, and the original reads answered.
    const replied = await json<RunpaneReplyResult>(pane, ['reply', 'M-1', 'Yes, frozen until Friday.'], caller(billing));
    expect(replied.reply).toMatchObject({ ref: 'M-2', kind: 'reply', replyTo: 'M-1' });
    await expect.poll(() => transcript(page, omni.panelId), { timeout: 30_000 })
      .toContain('reply: M-1 → \\"Yes, frozen until Friday.\\" (from the \\"Billing\\" Session orchestrator) [M-2');
    const shown = await json<RunpaneMessageShowResult>(pane, ['messages', 'show', 'M-1']);
    expect(shown.message).toMatchObject({ state: 'answered', replies: ['M-2'], sender: { panelId: omni.panelId }, receiver: { panelId: billing.panelId } });
    expect(shown.replies[0]).toMatchObject({ state: 'delivered', deliveredVia: 'tab' });
    await evidence(page, omni, '02-reply-in-sender', `reply (as Billing) → ${JSON.stringify(replied, null, 2)}\nmessages show M-1 → ${JSON.stringify(shown, null, 2)}\n`);

    // A's tab is down (its agent exited, as after a restart) when B answers: Pane resumes it and types the reply.
    expect((await ask('Who owns invoices?')).messageId).toBe('M-3');
    // A's agent exits (the scripted agent's `crash`), so its tab is down when B answers.
    await json(pane, ['panels', 'submit', '--panel', omni.panelId, '--text', 'crash', '--source', 'user', '--yes']);
    // Read with runpane, not the chat view: opening a chat in the app starts its agent again.
    const running = async () => (await json<{ panels: Array<{ id: string; running?: boolean }> }>(pane, ['panels', 'list', '--pane', omni.paneId])).panels.find(item => item.id === omni.panelId)?.running;
    await expect.poll(running, { timeout: 30_000 }).toBe(false);
    await json(pane, ['reply', 'M-3', 'The Billing team.'], caller(billing));
    await expect.poll(() => transcript(page, omni.panelId), { timeout: 60_000 }).toContain('reply: M-3 → \\"The Billing team.\\"');
    expect((await json<RunpaneMessageShowResult>(pane, ['messages', 'show', 'M-3'])).replies[0]).toMatchObject({ ref: 'M-4', state: 'delivered' });

    // --await-reply: A's submit returns B's reply as its result, and it isn't typed into A's tab as well.
    const waiting = json<RunpaneMessageWaitResult>(pane, ['panels', 'submit', '--panel', billing.panelId, '--text', 'Ship Friday?', '--no-expect-report', '--await-reply', '--timeout', '45s', '--yes'], caller(omni));
    await expect.poll(async () => (await json<{ messages: AgentMessageRecord[] }>(pane, ['messages', 'list', '--all'])).messages[0]?.ref, { timeout: 30_000 }).toBe('M-5');
    await json(pane, ['reply', 'M-5', 'Yes, ship Friday.'], caller(billing));
    const awaited = await waiting;
    expect(awaited).toMatchObject({ ok: true, outcome: 'reply', message: 'M-5', reply: { ref: 'M-6', text: 'Yes, ship Friday.', deliveredVia: 'call' } });
    expect(await transcript(page, omni.panelId)).not.toContain('reply: M-5');

    // What the app reads for a tab's history: every message it sent or received, newest first.
    const records = await forPanel(page, omni.panelId);
    expect(records.map(record => [record.ref, record.kind, record.replyTo, record.state])).toEqual([
      ['M-6', 'reply', 'M-5', 'delivered'], ['M-5', 'message', null, 'answered'], ['M-4', 'reply', 'M-3', 'delivered'],
      ['M-3', 'message', null, 'answered'], ['M-2', 'reply', 'M-1', 'delivered'], ['M-1', 'message', null, 'answered'],
    ]);
    await evidence(page, omni, '03-after-await-reply', `panels submit --await-reply (as Omni Chat) → ${JSON.stringify(awaited, null, 2)}\nagent-messages:for-panel (Omni Chat) → ${JSON.stringify(records, null, 2)}\n`);
  } finally {
    await close();
  }
});
