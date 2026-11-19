import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { installElectronApiMock, gotoApp } from './electronApiMock';
import { projects, session } from './sidebarCompactFixture';

// #1595: the resize handle's grab area covered the sidebar list's scrollbar,
// which sits flush against the sidebar's right edge, so the scrollbar thumb
// could not be dragged. The grab area now reaches outward only.

// Headless Chromium hides scrollbars by default, leaving nothing to grab; keep them.
const test = base.extend<object, object>({
  launchOptions: [async ({ launchOptions }, use) => {
    await use({ ...launchOptions, ignoreDefaultArgs: ['--hide-scrollbars'] });
  }, { scope: 'worker' }],
});

async function openSidebar(page: Page, theme: string, width: number, scrollbarWidth?: number) {
  await page.addInitScript((stored) => localStorage.setItem('pane-sidebar-width', stored), String(width));
  await installElectronApiMock(page, {
    initialConfig: { theme },
    initialProjects: projects,
    // Enough panes that the list scrolls at the test viewport's height.
    initialSessions: Array.from({ length: 60 }, (_, i) => session(`resize-${i}`, `resize pane ${i}`, 1)),
    initialUiState: { expandedProjects: [1], repositoriesSectionExpanded: true },
  });
  await gotoApp(page);
  await expect(page.locator('html')).toHaveClass(new RegExp(theme));
  // A classic Windows-width scrollbar, wider than the app's own 6px one.
  if (scrollbarWidth) {
    await page.addStyleTag({ content: `.pane-sidebar-list::-webkit-scrollbar { width: ${scrollbarWidth}px !important; }` });
  }
  const sidebar = page.getByTestId('sidebar');
  const list = sidebar.locator('.pane-sidebar-list');
  await expect(list.getByText('resize pane 59', { exact: true })).toBeAttached();
  await expect.poll(() => sidebarWidth(sidebar)).toBe(width);
  return { sidebar, list };
}

async function sidebarWidth(sidebar: Locator) {
  return Math.round((await sidebar.boundingBox())?.width ?? 0);
}

async function drag(page: Page, x: number, y: number, dx: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + 20, { steps: 4 });
  await page.mouse.move(x + dx, y + 40, { steps: 4 });
  await page.mouse.up();
}

test.describe('sidebar resize handle', () => {
  for (const theme of ['night-owl', 'light']) {
    for (const { width, scrollbarWidth, label } of [
      { width: 352, scrollbarWidth: undefined, label: 'app scrollbar' },
      { width: 220, scrollbarWidth: 17, label: 'classic scrollbar' },
    ]) {
      test(`leaves the list scrollbar draggable and still resizes from the edge (${theme}, ${width}px, ${label})`, async ({ page }) => {
        const { sidebar, list } = await openSidebar(page, theme, width, scrollbarWidth);
        const metrics = await list.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return {
            right: rect.right,
            gutter: el.offsetWidth - el.clientWidth,
            top: rect.top,
            scrollable: el.scrollHeight > el.clientHeight,
          };
        });
        expect(metrics.scrollable).toBe(true);
        expect(metrics.gutter).toBeGreaterThan(0);

        // Press the middle of the scrollbar, on its thumb at the top, and drag it down.
        const thumbX = metrics.right - metrics.gutter / 2;
        const target = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.getAttribute('data-testid'), { x: thumbX, y: metrics.top + 6 });
        expect(target).toBe('sidebar');
        await drag(page, thumbX, metrics.top + 6, 60);
        expect(await sidebarWidth(sidebar)).toBe(width);
        await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

        // The edge still resizes: from just outside the sidebar, and on its border.
        const edge = (await sidebar.boundingBox())!.x + width;
        const handle = page.getByTestId('sidebar-resize-handle');
        await expect(handle).toHaveCSS('cursor', 'col-resize');
        await drag(page, edge + 4, 300, 40);
        await expect.poll(() => sidebarWidth(sidebar)).toBe(width + 44);
        await drag(page, edge + 44 - 1, 300, -30);
        await expect.poll(() => sidebarWidth(sidebar)).toBe(width + 13);

        // Hovering the grab area outside the sidebar lights the indicator on the sidebar's edge.
        const indicator = handle.locator('[aria-hidden="true"]');
        await page.mouse.move(800, 500);
        await expect(indicator).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await page.mouse.move(edge + 13 + 4, 300);
        await expect(indicator).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        const lit = (await indicator.boundingBox())!;
        expect(lit.x + lit.width).toBeLessThanOrEqual(edge + 13);
        await page.screenshot({ path: `tmp/verify/sidebar-resize/${theme}-${width}-hover.png` });
      });
    }
  }
});
