import { expect, test } from '@playwright/test';
import { emitRemoteHostEvent, openConnectedRemotePwa, dropRemoteConnection, restoreRemoteConnection } from './remotePwaMock';
import type { AgentChatView, AgentChatEvent, AgentChatReceipt } from '../shared/types/agentChat';
import { boundary, decodeBoundary } from '../shared/validation/boundaryDecoder';

test('streams a bounded Chat thread through the remote client and reconnects without stopping its host', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openConnectedRemotePwa(page, { sessionNames: ['Chat fixture'], panelTitles: ['Claude'], chatEnabled: true });
  const conversation = { panelId: 'anim-panel-0', workspaceId: 'anim-remote-0', provider: 'claude' as const, nativeSessionId: 'exact-native-id', generation: 2, active: 'chat' as const, preferred: 'chat' as const };
  const view: AgentChatView = { panelId: conversation.panelId, conversation, available: true, setupRequired: false, running: false, permissions: [], transcript: {
    panelId: conversation.panelId, generation: 2, revision: 0,
    messages: Array.from({ length: 1500 }, (_, index) => ({ id: `history-${index}`, role: 'assistant', parts: [{ type: 'text', text: `Historical reply ${index}` }] })),
  } };
  const panel = { id: conversation.panelId, sessionId: conversation.workspaceId, type: 'terminal', title: 'Claude',
    state: { isActive: true, customState: { agentType: 'claude', agentChat: { conversation } } }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
  const mutations: string[] = [];
  const recoveries: unknown[][] = [];
  let reads = 0;
  await page.route('http://anim-pane.test/**', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = decodeBoundary(JSON.parse(route.request().postData() ?? '{}'), boundary.object({ channel: boundary.string, args: boundary.array(boundary.json) }));
    if (body.channel === 'panels:list' || body.channel === 'panels:getActive') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: body.channel === 'panels:list' ? [panel] : panel }) });
    if (!body.channel.startsWith('agent-chat:')) return route.fallback();
    if (body.channel === 'agent-chat:recover') recoveries.push(body.args);
    if (body.channel === 'agent-chat:get') reads++;
    else mutations.push(body.channel);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: body.channel === 'agent-chat:get' ? view : null }) });
  });
  const started = Date.now();
  await emitRemoteHostEvent(page, 'panel:updated', decodeBoundary(panel, boundary.json));
  const composer = page.getByRole('textbox', { name: 'Message agent' });
  await expect(composer).toBeVisible();
  await expect(page.getByText('Historical reply 1499', { exact: true })).toBeVisible();
  expect(await page.getByText(/^Historical reply \d+$/).count()).toBeLessThanOrEqual(200);
  await composer.fill('Keep my draft');
  view.running = true;
  await emitRemoteHostEvent(page, 'agent-chat:state', decodeBoundary(view, boundary.json));
  // Grow the external store rapidly: this previously mounted MessageByIndex
  // before assistant-ui synchronized its own runtime, crashing the entire panel.
  for (let index = 1; index <= 12; index++) {
    const event: AgentChatEvent = { panelId: conversation.panelId, generation: 2, revision: index, change: { type: 'append', id: `stream-${index}`, role: 'assistant', part: { type: 'text', text: `Stream reply ${index}` } } };
    view.transcript!.revision = index;
    view.transcript!.messages.push({ id: `stream-${index}`, role: 'assistant', parts: [{ type: 'text', text: `Stream reply ${index}` }] });
    await emitRemoteHostEvent(page, 'agent-chat:event', decodeBoundary(event, boundary.json));
  }
  await expect(composer).toBeVisible();
  await expect(page.getByText('Stream reply 12', { exact: true })).toBeInViewport();
  // Reading older output pauses follow; the latest control must leave the
  // pinned page as well as scrolling its viewport.
  const viewport = page.getByRole('region', { name: 'Conversation messages' });
  await viewport.hover();
  await page.mouse.wheel(0, -600);
  await expect(page.getByText('Stream reply 12', { exact: true })).not.toBeInViewport();
  const next: AgentChatEvent = { panelId: conversation.panelId, generation: 2, revision: 13, change: { type: 'append', id: 'stream-13', role: 'assistant', part: { type: 'text', text: 'Stream reply 13' } } };
  view.transcript!.revision = 13;
  view.transcript!.messages.push({ id: 'stream-13', role: 'assistant', parts: [{ type: 'text', text: 'Stream reply 13' }] });
  await emitRemoteHostEvent(page, 'agent-chat:event', decodeBoundary(next, boundary.json));
  await expect(page.getByRole('button', { name: 'Latest messages (1 newer)', exact: true })).toBeAttached();
  await expect(page.getByText('Stream reply 13', { exact: true })).not.toBeAttached();
  await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).click();
  await expect(page.getByText('Stream reply 13', { exact: true })).toBeInViewport();
  await page.getByRole('button', { name: /^Earlier messages/ }).click();
  await expect(page.getByText('Stream reply 13', { exact: true })).not.toBeAttached();
  await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).click();
  await expect(page.getByText('Stream reply 13', { exact: true })).toBeInViewport();
  await dropRemoteConnection(page);
  await expect(page.getByText('Reconnecting…', { exact: true })).toBeVisible();
  const previousReads = reads;
  view.running = false;
  view.permissions = [{ id: 'permission-1', generation: 2, title: 'Edit fixture.txt', toolCall: { path: 'fixture.txt' }, options: [{ optionId: 'reject-once', kind: 'reject_once', name: 'Reject this edit' }] }];
  await restoreRemoteConnection(page);
  await expect.poll(() => reads).toBeGreaterThan(previousReads);
  await expect(page.getByRole('button', { name: 'Reject this edit' })).toBeVisible();
  await expect(composer).toHaveValue('Keep my draft');
  await page.getByRole('button', { name: 'Reject this edit' }).click();
  await expect.poll(() => mutations).toEqual(['agent-chat:permission']);
  view.error = 'The agent could not complete this turn: Provider authentication expired. Check the provider connection.';
  await page.locator('.chat-header').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Refresh conversation', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alert')).toContainText('Provider authentication expired');
  expect(mutations).toEqual(['agent-chat:permission']);
  view.error = undefined;
  view.conversation = { ...conversation, active: 'stopped', transition: { source: 'chat', target: 'terminal', phase: 'releasing' }, recovery: 'The previous handoff was interrupted.' };
  view.permissions = [];
  await emitRemoteHostEvent(page, 'agent-chat:state', decodeBoundary(view, boundary.json));
  await expect(page.getByText('The previous handoff was interrupted.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Claude', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitemradio', { name: 'View as Terminal', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Recover exact conversation', exact: true }).click();
  await expect.poll(() => recoveries).toEqual([[conversation.panelId, 'terminal', conversation.generation]]);
  expect(errors).toEqual([]);
  await testInfo.attach('large-thread-metrics', { body: JSON.stringify({ historyMessages: 1500, maximumMountedMessages: 200, elapsedMs: Date.now() - started, snapshotBytes: JSON.stringify(view).length, reads }), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('chat-remote-reconnected.png') });
});


test('keeps an uncertain draft visible and retries only its original delivery', async ({ page }) => {
  await openConnectedRemotePwa(page, { sessionNames: ['Delivery fixture'], panelTitles: ['Claude'], chatEnabled: true });
  const conversation = { panelId: 'anim-panel-0', workspaceId: 'anim-remote-0', provider: 'claude' as const, nativeSessionId: 'delivery-native-id', generation: 2, active: 'chat' as const, preferred: 'chat' as const };
  const view: AgentChatView = { panelId: conversation.panelId, conversation, available: true, setupRequired: false, running: false, permissions: [], transcript: { panelId: conversation.panelId, generation: 2, revision: 0, messages: [] } };
  const panel = { id: conversation.panelId, sessionId: conversation.workspaceId, type: 'terminal', title: 'Claude', state: { isActive: true, customState: { agentType: 'claude', agentChat: { conversation } } }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
  const deliveries: unknown[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('http://anim-pane.test/**', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = decodeBoundary(JSON.parse(route.request().postData() ?? '{}'), boundary.object({ channel: boundary.string, args: boundary.array(boundary.json) }));
    let result: AgentChatView | AgentChatReceipt | typeof panel | Array<typeof panel> | null;
    if (body.channel === 'panels:list') result = [panel];
    else if (body.channel === 'panels:getActive') result = panel;
    else if (body.channel === 'agent-chat:get') result = view;
    else if (body.channel === 'agent-chat:send') {
      deliveries.push(body.args[1]);
      if (deliveries.length === 1) {
        await held;
        return route.abort('failed');
      }
      const request = decodeBoundary(body.args[1], boundary.object({ operationId: boundary.string }));
      result = { operationId: request.operationId, fingerprint: 'fixture', state: 'accepted', generation: 2 };
    } else if (body.channel === 'agent-chat:receipt') result = null;
    else return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result }) });
  });
  await emitRemoteHostEvent(page, 'panel:updated', decodeBoundary(panel, boundary.json));
  const composer = page.getByRole('textbox', { name: 'Message agent' });
  await composer.fill('Keep this until the host confirms it');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => deliveries.length).toBe(1);
  await expect(composer).toHaveValue('Keep this until the host confirms it');
  await expect(composer).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole('alert')).toContainText('Check delivery before sending again');
  await restoreRemoteConnection(page);
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeEnabled();
  await expect(composer).toHaveValue('Keep this until the host confirms it');
  await page.getByRole('button', { name: 'Check delivery', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The host has no receipt yet');
  expect(deliveries).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry same delivery', exact: true }).click();
  await expect(composer).toHaveValue('');
  expect(deliveries).toHaveLength(2);
  expect(deliveries[1]).toEqual(deliveries[0]);
});

for (const theme of ['light', 'dark']) test(`keeps pending-switch and reconnect controls readable in a narrow header (${theme})`, async ({ page }, testInfo) => {
  if (testInfo.project.name === 'phone') await page.setViewportSize({ width: 320, height: 844 });
  await openConnectedRemotePwa(page, { sessionNames: ['Header fixture'], panelTitles: ['Claude'], chatEnabled: true });
  const conversation = { panelId: 'anim-panel-0', workspaceId: 'anim-remote-0', provider: 'claude' as const, nativeSessionId: 'header-native-id', generation: 2, active: 'chat' as const, preferred: 'chat' as const, pendingSwitch: { target: 'terminal' as const, reason: 'Wait for the active turn' } };
  const view: AgentChatView = { panelId: conversation.panelId, conversation, available: true, setupRequired: false, running: true, permissions: [], transcript: { panelId: conversation.panelId, generation: 2, revision: 0, messages: [] } };
  const panel = { id: conversation.panelId, sessionId: conversation.workspaceId, type: 'terminal', title: 'Claude', state: { isActive: true, customState: { agentType: 'claude', agentChat: { conversation } } }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
  await page.route('http://anim-pane.test/**', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = decodeBoundary(JSON.parse(route.request().postData() ?? '{}'), boundary.object({ channel: boundary.string }));
    const result = body.channel === 'panels:list' ? [panel] : body.channel === 'panels:getActive' ? panel : body.channel === 'agent-chat:get' ? view : undefined;
    if (!result) return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result }) });
  });
  await emitRemoteHostEvent(page, 'panel:updated', decodeBoundary(panel, boundary.json));
  const header = page.locator('.chat-header');
  await expect(header).toBeVisible();
  await header.evaluate(element => { element.style.width = '320px'; });
  await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
  for (const disconnected of [false, true]) {
    if (disconnected) await dropRemoteConnection(page);
    const status = header.getByRole('status');
    await expect(status).toHaveText(disconnected ? 'Reconnecting…' : 'Switch to Terminal after this turn');
    await expect(status).toBeVisible();
    const cancel = header.getByRole('button', { name: 'Cancel pending switch' });
    await expect(cancel).toBeVisible();
    const statusBox = (await status.boundingBox())!;
    const cancelBox = (await cancel.boundingBox())!;
    expect(statusBox.width).toBeGreaterThan(100);
    expect(statusBox.y + statusBox.height <= cancelBox.y || statusBox.x + statusBox.width <= cancelBox.x).toBe(true);
    expect(await header.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await header.screenshot({ path: testInfo.outputPath(`header-${disconnected ? 'reconnecting' : 'pending'}-${theme}.png`) });
  }
});
