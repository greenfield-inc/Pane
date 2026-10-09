import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

declare global {
  interface Window { selectionTest: { commits: () => Array<{ selected?: string; contents: Array<string | null>; focused: string | null }>; resetCommits: () => void; runtimeRefreshes: () => number; emit: (kind: 'host' | 'pane' | 'resync') => void; resolve: (kind: string, id: string, error?: string) => void; state: () => { route: string; session?: string; pane: string | null }; pending: () => Array<{ kind: string; id: string }> } }
}

async function resolve(page: import('@playwright/test').Page, kind: string, id: string, error?: string) {
  await expect.poll(() => page.evaluate(({ kind, id }) => window.selectionTest.pending().some(request => request.kind === kind && request.id === id), { kind, id })).toBe(true);
  await page.evaluate(({ kind, id, error }) => {
    // The fixture exposes controls for its Electron transport, never stores.
    const fixture = window.selectionTest;
    fixture.resolve(kind, id, error);
  }, { kind, id, error });
}
async function state(page: import('@playwright/test').Page) {
  return page.evaluate(() => window.selectionTest.state());
}

test.beforeEach(async ({ page }) => { await page.goto('/renderer-tests/selection.html'); });

test('Session click immediately owns title, highlight, route and loading content; late A cannot replace B', async ({ page }) => {
  await page.getByRole('button', { name: 'Open Session Session A', exact: true }).click();
  await page.getByRole('button', { name: 'Open Session Session B', exact: true }).click();
  await expect(page).toHaveTitle(/Session B/);
  expect(await state(page)).toMatchObject({ route: 'pane-chat', session: 'b', pane: null });
  await expect(page.getByRole('status').filter({ hasText: 'Opening Session B' })).toBeVisible();
  await resolve(page, 'select', 'b');
  await resolve(page, 'select', 'a');
  await expect(page).toHaveTitle(/Session B/);
  expect(await state(page)).toMatchObject({ route: 'pane-chat', session: 'b' });
});

test('managed Pane click switches immediately and late parent selection cannot activate A', async ({ page }) => {
  await page.getByRole('button', { name: 'Pane A', exact: true }).click();
  await page.getByRole('button', { name: 'Pane B', exact: true }).click();
  await expect(page).toHaveTitle(/Pane B/);
  expect(await state(page)).toMatchObject({ route: 'sessions', pane: 'b' });
  await expect(page.getByRole('status').filter({ hasText: 'Opening Pane B' })).toBeVisible();
  await resolve(page, 'select', 'b');
  await resolve(page, 'select', 'a');
  await expect(page).toHaveTitle(/Pane B/);
  expect(await state(page)).toMatchObject({ route: 'sessions', pane: 'b' });
});

test('failed clicked Session keeps its title and route, offers retry, and ignores old failures', async ({ page }) => {
  await page.getByRole('button', { name: 'Open Session Session A', exact: true }).click();
  await page.getByRole('button', { name: 'Open Session Session B', exact: true }).click();
  await resolve(page, 'select', 'b', 'Remote selection failed');
  await expect(page.getByRole('alert').filter({ hasText: 'Remote selection failed' }).last()).toBeVisible();
  await expect(page).toHaveTitle(/Session B/);
  expect(await state(page)).toMatchObject({ route: 'pane-chat', session: 'b' });
  await page.getByRole('button', { name: 'Retry', exact: true }).last().click();
  await expect(page.getByRole('status').filter({ hasText: 'Opening Session B' })).toBeVisible();
  await resolve(page, 'select', 'b');
  await resolve(page, 'select', 'a', 'Old A error');
  await expect(page.getByText('Old A error')).toHaveCount(0);
  await expect(page).toHaveTitle(/Session B/);
});

test('failed clicked Pane stays selected with retry; an old visit cannot replace a newer visit', async ({ page }) => {
  await page.getByRole('button', { name: 'Pane A', exact: true }).click();
  await page.getByRole('button', { name: 'Pane B', exact: true }).click();
  await resolve(page, 'panels', 'b', 'Pane B unavailable');
  await expect(page.getByRole('alert').filter({ hasText: 'Pane B unavailable' })).toBeVisible();
  await expect(page).toHaveTitle(/Pane B/);
  expect(await state(page)).toMatchObject({ route: 'sessions', pane: 'b' });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Opening Pane B' })).toBeVisible();
  await resolve(page, 'panels', 'a', 'Old A error');
  await expect(page.getByText('Old A error')).toHaveCount(0);
  await expect(page).toHaveTitle(/Pane B/);
});

test('late remembered Session layout cannot replace a clicked Session', async ({ page }) => {
  await page.goto('/renderer-tests/selection.html?hydrate');
  await page.getByRole('button', { name: 'Open Session Session A', exact: true }).click();
  await page.getByRole('button', { name: 'Open Session Session B', exact: true }).click();
  await resolve(page, 'select', 'b');
  await resolve(page, 'workspace', 'host');
  await expect(page).toHaveTitle(/Session B/);
  await expect(page.getByRole('status').filter({ hasText: 'Opening Session B' })).toBeVisible();
  expect(await state(page)).toMatchObject({ route: 'pane-chat', session: 'b' });
});

async function finishPane(page: import('@playwright/test').Page, id: string) {
  await resolve(page, 'panels', id);
  await expect.poll(() => page.evaluate(id => window.selectionTest.pending().some(request => request.kind === 'panels' && request.id === id), id)).toBe(true);
  await resolve(page, 'panels', id);
  await expect.poll(() => page.evaluate(id => window.selectionTest.pending().some(request => request.kind === 'layout' && request.id === id), id)).toBe(true);
  await resolve(page, 'layout', id);
}

test('Pane retry completes and returning to A ignores the first A visit', async ({ page }) => {
  await page.getByRole('button', { name: 'Pane A', exact: true }).click();
  await page.getByRole('button', { name: 'Pane B', exact: true }).click();
  await page.getByRole('button', { name: 'Pane A', exact: true }).click();
  await resolve(page, 'panels', 'a', 'Old visit failed');
  await expect(page.getByRole('status').filter({ hasText: 'Opening Pane A' })).toBeVisible();
  await resolve(page, 'panels', 'a', 'Current visit failed');
  await expect(page.getByRole('alert').filter({ hasText: 'Current visit failed' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await finishPane(page, 'a');
  await expect(page.locator('.pane-session-shell')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pane A', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Old visit failed')).toHaveCount(0);
  await expect(page).toHaveTitle(/Pane A/);
});

test('Session retry completes and loading B never shows the loaded A workspace', async ({ page }) => {
  await page.getByRole('button', { name: 'Open Session Session A', exact: true }).click();
  await resolve(page, 'select', 'a');
  await resolve(page, 'get', 'a', 'Current Session failed');
  await expect(page.getByRole('alert').filter({ hasText: 'Current Session failed' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).last().click();
  await resolve(page, 'get', 'a');
  await expect(page.locator('.pane-chat-shell')).toBeVisible();
  await page.getByRole('button', { name: 'Open Session Session B', exact: true }).click();
  await expect(page).toHaveTitle(/Session B/);
  await expect(page.locator('.pane-chat-shell')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Opening Session B' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Session Session B', exact: true }).locator('..')).toHaveClass(/bg-surface-selected/);
});

test('Session tool hydration hides cached tools and offers retry on failure', async ({ page }) => {
  await page.getByRole('button', { name: 'Open Session Session A', exact: true }).click();
  await resolve(page, 'select', 'a');
  await resolve(page, 'get', 'a');
  await expect(page.getByTestId('session-workspace-tabs')).toHaveCount(0);
  await resolve(page, 'panels', 'internal-a', 'Session tools unavailable');
  await expect(page.getByRole('alert').filter({ hasText: 'Session tools unavailable' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).last().click();
  await expect(page.getByRole('status').filter({ hasText: 'Opening Session tools' })).toBeVisible();
});

test('an old selected event snapshot cannot move B after its acknowledgement, but a new external event can', async ({ page }) => {
  await page.goto('/renderer-tests/selection.html?events');
  await page.getByRole('button', { name: 'Open Session Session B', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('orchestration-sessions-changed', { detail: { kind: 'selected' } })));
  await resolve(page, 'select', 'b');
  await resolve(page, 'list', 'a');
  await expect(page).toHaveTitle(/Session B/);
  await expect(page.getByRole('status').filter({ hasText: 'Opening Session B' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('orchestration-sessions-changed', { detail: { kind: 'selected' } })));
  await resolve(page, 'list', 'a');
  await expect(page).toHaveTitle(/Session A/);
});

test('B content stays mounted when the earlier A content reply arrives last', async ({ page }) => {
  await page.getByRole('button', { name: 'Open Session Session A', exact: true }).click();
  await page.getByRole('button', { name: 'Open Session Session B', exact: true }).click();
  await resolve(page, 'select', 'b');
  await resolve(page, 'get', 'b');
  await expect(page.locator('.pane-chat-shell')).toBeVisible();
  await resolve(page, 'get', 'a');
  await resolve(page, 'select', 'a');
  await expect(page.locator('.pane-chat-shell')).toBeVisible();
  await expect(page).toHaveTitle(/Session B/);
  expect(await state(page)).toMatchObject({ route: 'pane-chat', session: 'b' });
});

test('Pane layout transport failure stays in the clicked Pane with Retry', async ({ page }) => {
  await page.getByRole('button', { name: 'Pane B', exact: true }).click();
  await resolve(page, 'panels', 'b');
  await expect.poll(() => page.evaluate(() => window.selectionTest.pending().some(request => request.kind === 'panels' && request.id === 'b'))).toBe(true);
  await resolve(page, 'panels', 'b');
  await expect.poll(() => page.evaluate(() => window.selectionTest.pending().some(request => request.kind === 'layout' && request.id === 'b'))).toBe(true);
  await resolve(page, 'layout', 'b', 'Layout disconnected');
  await expect(page.getByRole('alert').filter({ hasText: 'Layout disconnected' })).toBeVisible();
  await expect(page).toHaveTitle(/Pane B/);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await finishPane(page, 'b');
  await expect(page.locator('.pane-session-shell')).toBeVisible();
});

test('Session tool layout transport failure stays in the Session with Retry', async ({ page }) => {
  await page.getByRole('button', { name: 'Open Session Session B', exact: true }).click();
  await resolve(page, 'select', 'b');
  await resolve(page, 'get', 'b');
  await resolve(page, 'panels', 'internal-b');
  await expect.poll(() => page.evaluate(() => window.selectionTest.pending().some(request => request.kind === 'layout' && request.id === 'internal-b'))).toBe(true);
  await resolve(page, 'layout', 'internal-b', 'Tool layout disconnected');
  await expect(page.getByRole('alert').filter({ hasText: 'Tool layout disconnected' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).last().click();
  await resolve(page, 'panels', 'internal-b');
  await expect.poll(() => page.evaluate(() => window.selectionTest.pending().some(request => request.kind === 'layout' && request.id === 'internal-b'))).toBe(true);
  await resolve(page, 'layout', 'internal-b');
  await expect(page.getByTestId('session-workspace-tabs')).toBeVisible();
});

for (const oldError of [undefined, 'Outgoing host failed']) {
  test(`host runtime resync drops outgoing colliding Pane ${oldError ? 'failure' : 'success'} before its first read finishes`, async ({ page }) => {
    await page.goto('/renderer-tests/selection.html?runtime');
    await page.evaluate(() => window.selectionTest.emit('pane'));
    await expect.poll(() => page.evaluate(() => window.selectionTest.pending().some(request => request.kind === 'pane'))).toBe(true);
    await page.evaluate(() => window.selectionTest.emit('host'));
    await expect.poll(() => page.evaluate(() => window.selectionTest.pending().some(request => request.kind === 'expanded'))).toBe(true);
    await page.evaluate(() => window.selectionTest.emit('pane'));
    await resolve(page, 'pane', 'a', oldError);
    await expect(page.getByRole('status').filter({ hasText: 'Opening a' })).toBeVisible();
    await expect(page.getByText('Outgoing host failed')).toHaveCount(0);
    await expect(page).not.toHaveTitle(/outgoing Pane A/);
    await resolve(page, 'pane', 'a');
    await expect(page).toHaveTitle(/incoming Pane A/);
  });
}

test('the first B commit never contains the loaded single A workspace', async ({ page }) => {
  await page.getByRole('button', { name: 'Open Session Session A', exact: true }).click();
  await resolve(page, 'get', 'a');
  await expect(page.locator('[data-session-content-id="a"]')).toBeVisible();
  await page.evaluate(() => window.selectionTest.resetCommits());
  await page.getByRole('button', { name: 'Open Session Session B', exact: true }).click();
  const commits = await page.evaluate(() => window.selectionTest.commits().filter(commit => commit.selected === 'b'));
  const artifactBundle = process.env.AGENT_FARM_ARTIFACT_BUNDLE;
  const observationPath = artifactBundle ? join(artifactBundle, 'evidence', 'session-commit-observations.json') : test.info().outputPath('session-commit-observations.json');
  await writeFile(observationPath, JSON.stringify(commits, null, 2));
  await test.info().attach('session-commit-observations', { path: observationPath, contentType: 'application/json' });
  expect(commits.length).toBeGreaterThan(0);
  expect(commits.every(commit => commit.focused === 'b' && !commit.contents.includes('a'))).toBe(true);
});

test('reclicking a loaded Session immediately starts a fresh visit', async ({ page }) => {
  await page.getByRole('button', { name: 'Open Session Session A', exact: true }).click();
  await resolve(page, 'get', 'a');
  await expect(page.locator('[data-session-content-id="a"]')).toBeVisible();
  await page.getByRole('button', { name: 'Open Session Session A', exact: true }).click();
  await expect(page.locator('[data-session-content-id="a"]')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Opening Session A' })).toBeVisible();
  await resolve(page, 'get', 'a');
  await expect(page.locator('[data-session-content-id="a"]')).toBeVisible();
});

test('persistent tiles reject the earlier A visit while preserving the unrelated B workspace', async ({ page }) => {
  await page.goto('/renderer-tests/selection.html?tiles');
  await page.getByRole('button', { name: 'Open Session Session A', exact: true }).click();
  await expect(page.locator('[data-session-tile="b"]')).toBeVisible();
  await page.locator('[data-session-tile="b"]').click({ position: { x: 10, y: 10 } });
  await expect.poll(() => page.evaluate(() => window.selectionTest.pending().filter(request => request.kind === 'get' && request.id === 'b').length)).toBe(2);
  await resolve(page, 'get', 'b'); // Background visit superseded by the real focus gesture.
  await resolve(page, 'get', 'b');
  await expect(page.locator('[data-session-content-id="b"]')).toBeVisible();
  await page.getByRole('button', { name: 'Open Session Session A', exact: true }).click();
  await resolve(page, 'get', 'a'); // First visit's reply; the new visit must still load.
  await expect(page.locator('[data-session-tile="a"]').getByRole('status').filter({ hasText: 'Opening Session A' })).toBeVisible();
  await expect(page.locator('[data-session-content-id="b"]')).toBeVisible();
  await resolve(page, 'get', 'a');
  await expect(page.locator('[data-session-content-id="a"]')).toBeVisible();
});

for (const source of ['initial', 'resync']) {
  for (const collidingIds of [true, false]) {
    test(`late outgoing ${source} list cannot replace restored incoming host (colliding ids: ${collidingIds})`, async ({ page }) => {
      await page.goto(`/renderer-tests/selection.html?runtime-lists${collidingIds ? '' : '-no-collision'}`);
      if (source === 'resync') {
        await resolve(page, 'runtime-list', 'outgoing');
        await page.evaluate(() => window.selectionTest.emit('resync'));
        await expect.poll(() => page.evaluate(() => window.selectionTest.pending().some(request => request.kind === 'runtime-list' && request.id === 'outgoing'))).toBe(true);
      }
      await page.evaluate(() => window.selectionTest.emit('host'));
      await resolve(page, 'expanded', 'host');
      await resolve(page, 'runtime-list', 'incoming');
      await resolve(page, 'memory', 'incoming');
      await expect(page).toHaveTitle(/incoming Pane A/);
      for (let index = 0; index < 5 && await page.evaluate(() => window.selectionTest.runtimeRefreshes()) === 0; index += 1) {
        await resolve(page, 'panels', 'a');
      }
      await expect.poll(() => page.evaluate(() => window.selectionTest.runtimeRefreshes())).toBe(1);
      expect(await state(page)).toMatchObject({ route: 'sessions', pane: 'a' });
      await resolve(page, 'runtime-list', 'outgoing');
      await expect(page).toHaveTitle(/incoming Pane A/);
      expect(await state(page)).toMatchObject({ route: 'sessions', pane: 'a' });
      expect(await page.evaluate(() => window.selectionTest.runtimeRefreshes())).toBe(1);
    });
  }
}

test('same-host reconnect retains failed Session intent and retry; explicit selection remains adoptable', async ({ page }) => {
  await page.goto('/renderer-tests/selection.html?runtime-events');
  await page.getByRole('button', { name: 'Open Session Session B', exact: true }).click();
  await resolve(page, 'select', 'b', 'Disconnected B');
  const tile = page.locator('[data-session-tile="b"]');
  await expect(tile.getByRole('alert')).toContainText('Disconnected B');
  await tile.getByRole('button', { name: 'Retry', exact: true }).click();
  await resolve(page, 'select', 'b', 'Disconnected B');
  await expect(tile.getByRole('alert')).toContainText('Disconnected B');
  await page.evaluate(() => window.selectionTest.emit('resync'));
  await expect.poll(() => page.evaluate(() => window.selectionTest.runtimeRefreshes())).toBe(1);
  await resolve(page, 'list', 'a');
  await expect(page).toHaveTitle(/Session B/);
  expect(await state(page)).toMatchObject({ session: 'b', route: 'pane-chat' });
  await expect(tile.getByRole('alert')).toContainText('Disconnected B');
  await page.getByRole('button', { name: 'Open Session Session B', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin Session', exact: true }).click();
  await resolve(page, 'update', 'b', 'Pin failed independently');
  await expect(page.locator('aside').getByRole('alert').filter({ hasText: 'Pin failed independently' })).toBeVisible();
  await tile.getByRole('button', { name: 'Retry', exact: true }).click();
  await resolve(page, 'select', 'b');
  await expect(page.getByRole('status').filter({ hasText: 'Opening Session B' })).toBeVisible();
  while (await page.evaluate(() => window.selectionTest.pending().some(request => request.kind === 'get' && request.id === 'b'))) {
    await resolve(page, 'get', 'b');
  }
  await expect(tile.locator('.pane-chat-shell')).toBeVisible();
  await expect(tile.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('aside').getByRole('alert').filter({ hasText: 'Disconnected B' })).toHaveCount(0);
  await expect(page.locator('aside').getByRole('alert').filter({ hasText: 'Pin failed independently' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('orchestration-sessions-changed', { detail: { kind: 'selected' } })));
  await resolve(page, 'list', 'a');
  await expect(page).toHaveTitle(/Session A/);
});

test('a different host adopts its Session selection after failed local intent', async ({ page }) => {
  await page.goto('/renderer-tests/selection.html?runtime-events');
  await page.getByRole('button', { name: 'Open Session Session B', exact: true }).click();
  await resolve(page, 'select', 'b', 'Disconnected B');
  await expect(page.locator('[data-session-tile="b"]').getByRole('alert')).toContainText('Disconnected B');
  await page.evaluate(() => window.selectionTest.emit('host'));
  await resolve(page, 'expanded', 'host');
  await expect.poll(() => page.evaluate(() => window.selectionTest.runtimeRefreshes())).toBe(1);
  await resolve(page, 'list', 'a');
  expect(await state(page)).toMatchObject({ session: 'a' });
  await expect(page.getByRole('button', { name: 'Open Session Session A', exact: true }).locator('..')).toHaveClass(/bg-surface-selected/);
});

test('explicit external selection remains authoritative while local Session selection has failed', async ({ page }) => {
  await page.goto('/renderer-tests/selection.html?runtime-events');
  await page.getByRole('button', { name: 'Open Session Session B', exact: true }).click();
  await resolve(page, 'select', 'b', 'Disconnected B');
  await expect(page.locator('[data-session-tile="b"]').getByRole('alert')).toContainText('Disconnected B');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('orchestration-sessions-changed', { detail: { kind: 'selected' } })));
  await resolve(page, 'list', 'a');
  await expect(page).toHaveTitle(/Session A/);
  expect(await state(page)).toMatchObject({ session: 'a', route: 'pane-chat' });
  await expect(page.locator('[data-session-tile="a"]').getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Opening Session A' })).toBeVisible();
});

for (const compact of [false, true]) {
  for (const reconnect of compact ? [false, true] : [false]) {
    test(`actual ${compact ? 'compact' : 'expanded'} sidebar Retry recovers clicked B (reconnect: ${reconnect})`, async ({ page }) => {
      await page.goto(`/renderer-tests/selection.html?runtime-events${compact ? '-compact' : ''}`);
      await page.getByRole('button', { name: 'Open Session Session B', exact: true }).click();
      await resolve(page, 'select', 'b', 'Disconnected B');
      const sidebar = page.locator('aside');
      if (reconnect) {
        await page.evaluate(() => window.selectionTest.emit('resync'));
        await expect.poll(() => page.evaluate(() => window.selectionTest.runtimeRefreshes())).toBe(1);
        await resolve(page, 'list', 'a');
        expect(await state(page)).toMatchObject({ error: null, selectionError: 'Disconnected B', session: 'b' });
      }
      await page.getByRole('button', { name: 'Open Session Session B', exact: true }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Pin Session', exact: true }).click();
      await resolve(page, 'update', 'b', 'Pin failed independently');
      const retry = compact ? sidebar.getByTestId('compact-sessions-error') : sidebar.getByRole('button', { name: 'Retry', exact: true });
      await retry.click();
      await expect.poll(() => page.evaluate(() => window.selectionTest.pending().filter(request => request.kind === 'select').map(request => request.id))).toEqual(['b']);
      expect(await state(page)).toMatchObject({ session: 'b', route: 'pane-chat' });
      await expect(page).toHaveTitle(/Session B/);
      await expect(page.getByRole('status').filter({ hasText: 'Opening Session B' })).toBeVisible();
      await resolve(page, 'select', 'b');
      while (await page.evaluate(() => window.selectionTest.pending().some(request => request.kind === 'get' && request.id === 'b'))) await resolve(page, 'get', 'b');
      await expect(page.locator('[data-session-content-id="b"]')).toBeVisible();
      await expect(page.getByRole('alert').filter({ hasText: 'Disconnected B' })).toHaveCount(0);
      if (compact) {
        await expect(sidebar.getByRole('alert', { name: 'Pin failed independently' })).toBeVisible();
        await expect(retry).toHaveCount(0);
      } else await expect(sidebar.getByRole('alert').filter({ hasText: 'Pin failed independently' })).toBeVisible();
    });
  }
}
