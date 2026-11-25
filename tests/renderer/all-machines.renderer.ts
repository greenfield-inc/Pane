import { expect, test, type Page } from '@playwright/test';

// Clicking a Session row on another machine switches hosts, and the switch must
// land on the clicked Session even when this desktop's stored layout for that
// host is focused on another one (D-241). The fixture is
// frontend/renderer-tests/all-machines.tsx.
type HostKey = 'local' | 'R';
type Layout = { root: { type: string; sessionId?: string; children?: Array<{ sessionId?: string }> }; focusedTileId: string };
declare global {
  interface Window {
    allMachinesTest: {
      main: { connecting: () => void; restoring: () => void; commit: () => void; connected: () => void };
      pendingSwitch: () => object | null;
      restores: () => number;
      calls: () => Array<{ method: string; host: HostKey; sessionId?: string; refused?: boolean }>;
      trail: () => Array<{ selected: string | null; highlighted: Array<string | null> }>;
      reset: () => void;
      memory: (host: HostKey) => string | null;
      rememberSession: (host: HostKey, sessionId: string) => void;
      storedLayout: (host: HostKey) => Layout | null;
      sharedPick: (host: HostKey) => string | null;
      switchMachine: (machineId: string) => void;
      state: () => { activeMachine: string | null; selectedSessionId: string | null; selectionError: string | null; availability: string; highlighted: Array<string | null>; shownError: string | null };
    };
  }
}

const fixture = (page: Page) => ({
  main: (step: 'connecting' | 'restoring' | 'commit' | 'connected') => page.evaluate(name => window.allMachinesTest.main[name](), step),
  state: () => page.evaluate(() => window.allMachinesTest.state()),
  calls: () => page.evaluate(() => window.allMachinesTest.calls()),
  trail: () => page.evaluate(() => window.allMachinesTest.trail()),
  memory: (host: HostKey) => page.evaluate(name => window.allMachinesTest.memory(name), host),
  sharedPick: (host: HostKey) => page.evaluate(name => window.allMachinesTest.sharedPick(name), host),
  storedLayout: (host: HostKey) => page.evaluate(name => window.allMachinesTest.storedLayout(name), host),
});

/** Opens the fixture on this computer, showing `showing`: Session X, or the focus of its stored layout. */
async function open(page: Page, query: string, showing = 'x') {
  await page.goto(`/renderer-tests/all-machines.html?${query}`);
  // An open modal hides the sidebar from the accessibility tree, so look for the row itself.
  await expect(page.locator('[aria-label="Session B on Remote R"]')).toBeAttached();
  await expect.poll(() => fixture(page).state()).toMatchObject({ selectedSessionId: showing });
}

const clickRow = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true }).click();

/** Main's order for a switch to R: connecting, restoring, resync, then connected once the renderer has restored. */
async function landOnRemote(page: Page, restores = 1) {
  const f = fixture(page);
  await expect.poll(() => page.evaluate(() => window.allMachinesTest.pendingSwitch())).not.toBeNull();
  await f.main('connecting');
  await f.main('restoring');
  await f.main('commit');
  await expect.poll(() => page.evaluate(() => window.allMachinesTest.restores())).toBe(restores);
  await f.main('connected');
}

async function landOnLocal(page: Page, restores: number) {
  await expect.poll(() => page.evaluate(() => window.allMachinesTest.pendingSwitch())).not.toBeNull();
  await fixture(page).main('commit');
  await expect.poll(() => page.evaluate(() => window.allMachinesTest.restores())).toBe(restores);
}

/** Past the navigation memory's 250 ms write debounce. */
const settle = (page: Page) => page.waitForTimeout(600);

test('S6a: a click on Session B on R opens B, though this desktop last focused D there', async ({ page }) => {
  await open(page, 'chat&layoutR=d&pickR=c');
  const f = fixture(page);
  await page.evaluate(() => window.allMachinesTest.reset());
  await clickRow(page, 'Session B on Remote R');
  await landOnRemote(page);
  await settle(page);

  expect(await f.state()).toEqual({ activeMachine: 'R', selectedSessionId: 'b', selectionError: null, availability: 'ready', highlighted: ['Session B on Remote R'], shownError: null });
  expect(await f.memory('R'), 'R remembers the clicked Session').toBe('b');
  // The selection never passes through another Session on the way.
  expect((await f.trail()).map(step => step.selected).filter(id => id !== null)).toEqual(['b']);
  // No stray select() reaches R while it is still restoring.
  expect((await f.calls()).filter(call => call.method === 'select')).toEqual([]);
  expect(await f.sharedPick('R'), 'R keeps the pick another client made').toBe('c');
  expect((await f.storedLayout('R'))?.root).toMatchObject({ type: 'session', sessionId: 'b' });
});

test('S6a with tiles: the clicked Session takes over the focused tile and the other tiles stay', async ({ page }) => {
  await open(page, 'chat&layoutR=c,d&pickR=c');
  const f = fixture(page);
  await clickRow(page, 'Session B on Remote R');
  await landOnRemote(page);
  await settle(page);

  expect(await f.state()).toMatchObject({ selectedSessionId: 'b', selectionError: null, availability: 'ready' });
  expect(await f.memory('R')).toBe('b');
  const layout = await f.storedLayout('R');
  expect(layout?.root.children?.map(tile => tile.sessionId)).toEqual(['c', 'b']);
});

test('S6b and S6c: a click still opens B with no stored layout, or one already focused on B', async ({ page }) => {
  for (const query of ['chat&pickR=c', 'chat&layoutR=b&pickR=c']) {
    await open(page, query);
    await clickRow(page, 'Session B on Remote R');
    await landOnRemote(page);
    await settle(page);
    expect(await fixture(page).state(), query).toMatchObject({ selectedSessionId: 'b', selectionError: null, availability: 'ready' });
    expect(await fixture(page).memory('R'), query).toBe('b');
  }
});

test('S6d: from R, a click on Session X on this computer opens X, though its layout is focused on Y', async ({ page }) => {
  await open(page, 'chat&layoutL=y&pickL=y', 'y');
  const f = fixture(page);
  await clickRow(page, 'Session B on Remote R');
  await landOnRemote(page);
  await settle(page);
  expect(await f.state()).toMatchObject({ activeMachine: 'R', selectedSessionId: 'b' });

  await page.evaluate(() => window.allMachinesTest.reset());
  await clickRow(page, 'Session X on laptop-L');
  await landOnLocal(page, 2);
  await settle(page);

  expect(await f.state()).toEqual({ activeMachine: 'local', selectedSessionId: 'x', selectionError: null, availability: 'ready', highlighted: ['Session X on laptop-L'], shownError: null });
  expect(await f.memory('local')).toBe('x');
  expect((await f.trail()).map(step => step.selected).filter(id => id !== null)).toEqual(['x']);
  // Opening X here is this desktop's own choice; it does not move this computer's shared pick.
  expect((await f.calls()).filter(call => call.method === 'select')).toEqual([]);
  expect(await f.sharedPick('local')).toBe('y');
});

test('a click within one machine still opens the clicked Session', async ({ page }) => {
  await open(page, 'chat&layoutL=y', 'y');
  const f = fixture(page);
  await clickRow(page, 'Session X on laptop-L');
  await expect.poll(() => f.state()).toMatchObject({ selectedSessionId: 'x', highlighted: ['Session X on laptop-L'] });
  await clickRow(page, 'Session Y on laptop-L');
  await expect.poll(() => f.state()).toMatchObject({ selectedSessionId: 'y', highlighted: ['Session Y on laptop-L'] });
  await settle(page);
  expect(await f.memory('local')).toBe('y');
});

test('a plain switch from the machine menu restores the host’s own location and tile layout', async ({ page }) => {
  await open(page, 'chat&layoutR=c,d&pickR=b');
  const f = fixture(page);
  await page.evaluate(() => window.allMachinesTest.rememberSession('R', 'd'));
  await page.evaluate(() => window.allMachinesTest.switchMachine('R'));
  await landOnRemote(page);
  await settle(page);

  expect(await f.state()).toMatchObject({ activeMachine: 'R', selectedSessionId: 'd', selectionError: null, availability: 'ready' });
  expect(await f.memory('R')).toBe('d');
  const layout = await f.storedLayout('R');
  expect(layout?.root.children?.map(tile => tile.sessionId)).toEqual(['c', 'd']);
  expect(layout?.focusedTileId).toBe('tile-d');
});

test('a plain switch to a host this desktop remembers nothing for uses its stored layout', async ({ page }) => {
  await open(page, 'chat&layoutR=c,d&pickR=b');
  const f = fixture(page);
  await page.evaluate(() => window.allMachinesTest.switchMachine('R'));
  await landOnRemote(page);
  await settle(page);

  expect(await f.state()).toMatchObject({ activeMachine: 'R', selectedSessionId: 'd' });
  expect((await f.storedLayout('R'))?.root.children?.map(tile => tile.sessionId)).toEqual(['c', 'd']);
});

// D-266: New creates the Session on R, then switches there. The renderer's
// restore finishes before main marks R connected, so a select() sent then is refused.
test('a Session created on R from New opens there once the switch lands, with no error', async ({ page }) => {
  await open(page, 'chat&new&layoutR=d&pickR=c');
  const f = fixture(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: /Remote R/ }).click();
  await dialog.getByLabel('Session name (optional)').fill('Doozy');
  await page.evaluate(() => window.allMachinesTest.reset());
  await dialog.getByRole('button', { name: 'Create Session on Remote R', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await landOnRemote(page);
  await settle(page);

  expect(await f.state()).toEqual({ activeMachine: 'R', selectedSessionId: 'n', selectionError: null, availability: 'ready', highlighted: ['Session Doozy on Remote R'], shownError: null });
  expect(await f.memory('R'), 'R remembers the new Session').toBe('n');
  expect((await f.calls()).filter(call => call.method === 'select' && call.refused)).toEqual([]);
  expect((await f.storedLayout('R'))?.root).toMatchObject({ type: 'session', sessionId: 'n' });
});
