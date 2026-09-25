import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installElectronApiMock } from './electronApiMock';

// Before/after evidence capture for the animation pass. Each moment gets its own
// browser context so the video starts at a known instant, and each records the
// offset at which the interaction begins so the clips can be trimmed to the
// motion itself. Not part of any CI suite — driven by scripts/capture-anim-evidence.mjs.

const PHASE = process.env.PANE_ANIM_PHASE ?? 'before';
const OUT_DIR = path.resolve('tmp/anim-evidence', PHASE);
const VIEWPORT = { width: 1280, height: 800 };
// 5x slow motion: a 180ms transition becomes 900ms, which is ~22 frames of the
// 25fps capture instead of 4.
const SLOW_RATE = 0.2;

const project = {
  id: 1,
  name: 'dcouple/pane',
  path: '/tmp/pane',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const baseSession = {
  prompt: 'evidence fixture',
  status: 'stopped',
  createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  isFavorite: false,
  toolType: 'none',
  archived: false,
};

const sessions = [
  { ...baseSession, id: 'anim-pane-a', name: 'scrub Sentry request bodies (TM-622)', worktreePath: '/tmp/pane/wt/a', displayOrder: 0 },
  { ...baseSession, id: 'anim-pane-b', name: 'sidebar compact menu', worktreePath: '/tmp/pane/wt/b', displayOrder: 1 },
  { ...baseSession, id: 'anim-pane-c', name: 'title bar overlay insets', worktreePath: '/tmp/pane/wt/c', displayOrder: 2 },
  { ...baseSession, id: 'anim-pane-main', name: 'pane', worktreePath: '/tmp/pane', isMainRepo: true, displayOrder: 3 },
];

interface Region { x: number; y: number; width: number; height: number }

interface Mark {
  slug: string;
  /** ms from the start of the recording to the moment the interaction fires. */
  markMs: number;
  note: string;
  /** Viewport rectangle the clip should be cropped to, in CSS pixels. */
  region: Region;
}

/** Pads a rectangle, clamps it to the viewport, and snaps it to even pixels (h264). */
function frameRegion(box: Region, pad = 24): Region {
  const left = Math.max(0, Math.floor(box.x - pad));
  const top = Math.max(0, Math.floor(box.y - pad));
  const right = Math.min(VIEWPORT.width, Math.ceil(box.x + box.width + pad));
  const bottom = Math.min(VIEWPORT.height, Math.ceil(box.y + box.height + pad));
  const even = (value: number) => value - (value % 2);
  return { x: even(left), y: even(top), width: even(right - left), height: even(bottom - top) };
}

const FULL_VIEWPORT: Region = { x: 0, y: 0, ...VIEWPORT };

const marks: Mark[] = [];

async function openDesktop(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'platform', { get: () => 'MacIntel' });
  });
  await installElectronApiMock(page, {
    platform: 'darwin',
    analyticsConsentShown: true,
    initialProjects: [project],
    initialSessions: sessions,
    initialUiState: { expandedProjects: [project.id] },
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 20_000 });
}

/**
 * Records one moment. `setup` runs at full speed; `action` runs with Chromium's
 * animation clock slowed so a 200ms curve is legible frame by frame.
 */
async function capture(
  browser: Browser,
  slug: string,
  note: string,
  setup: (page: Page) => Promise<void>,
  action: (page: Page) => Promise<void>,
  region: (page: Page) => Promise<Region> = async () => FULL_VIEWPORT,
  // Most regions are the surface the animation brings on screen, so they are
  // measured once the motion settles. A moment that leaves the screen — a press
  // that dismisses its own dialog — has to be measured up front instead.
  measureRegion: 'after' | 'before' = 'after',
): Promise<void> {
  // The recording size has to match the viewport: Playwright pads a larger
  // canvas rather than scaling the page into it, which would offset every crop.
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: path.join(OUT_DIR, 'raw', slug), size: VIEWPORT },
  });
  const startedAt = Date.now();
  const page = await context.newPage();
  try {
    await openDesktop(page);
    await setup(page);
    await page.waitForTimeout(600);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: SLOW_RATE });
    await page.waitForTimeout(250);

    const early = measureRegion === 'before' ? await region(page) : null;
    const markMs = Date.now() - startedAt;
    await action(page);
    await page.waitForTimeout(2500);
    marks.push({ slug, markMs, note, region: early ?? await region(page) });
  } finally {
    const video = page.video();
    await context.close();
    if (video) await video.saveAs(path.join(OUT_DIR, `${slug}.webm`));
  }
}

/** The bounding box of a locator, framed for the clip. */
async function boxOf(page: Page, selector: string, pad = 24): Promise<Region> {
  const box = await page.locator(selector).first().boundingBox();
  return box ? frameRegion(box, pad) : FULL_VIEWPORT;
}

test.describe.configure({ mode: 'serial' });

test.describe('animation evidence', () => {
  test.afterAll(async () => {
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(
      path.join(OUT_DIR, 'marks.json'),
      `${JSON.stringify({ viewport: VIEWPORT, marks }, null, 2)}\n`,
    );
  });

  test('command-palette-open', async ({ browser }) => {
    await capture(
      browser,
      'command-palette-open',
      'Cmd+Shift+P opens the command palette',
      async () => {},
      async (page) => {
        await page.keyboard.press('Meta+Shift+P');
        await expect(page.getByPlaceholder('Search commands...')).toBeVisible();
      },
      (page) => boxOf(page, '[role="dialog"]', 48),
    );
  });

  test('command-palette-arrow', async ({ browser }) => {
    await capture(
      browser,
      'command-palette-arrow',
      'Arrow keys move the selection through the command list',
      async (page) => {
        await page.keyboard.press('Meta+Shift+P');
        await expect(page.getByPlaceholder('Search commands...')).toBeVisible();
      },
      async (page) => {
        for (let i = 0; i < 6; i += 1) {
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(220);
        }
      },
      (page) => boxOf(page, '[role="listbox"]', 12),
    );
  });

  test('sidebar-collapse', async ({ browser }) => {
    await capture(
      browser,
      'sidebar-collapse',
      'Collapsing and re-expanding the sidebar',
      async () => {},
      async (page) => {
        await page.getByRole('button', { name: 'Collapse sidebar' }).click();
        await page.waitForTimeout(2600);
        await page.getByRole('button', { name: 'Expand sidebar' }).click();
      },
      async () => ({ x: 0, y: 0, width: 760, height: 800 }),
    );
  });

  test('sidebar-menu-open', async ({ browser }) => {
    await capture(
      browser,
      'sidebar-menu-open',
      'The sidebar overflow menu opening from its trigger',
      async () => {},
      async (page) => {
        await page.getByRole('button', { name: 'Home menu' }).click();
        await expect(page.getByRole('menu')).toBeVisible();
      },
      (page) => boxOf(page, '[role="menu"]', 52),
    );
  });

  test('menu-row-highlight', async ({ browser }) => {
    await capture(
      browser,
      'menu-row-highlight',
      'Running the pointer down the menu rows',
      async (page) => {
        await page.getByRole('button', { name: 'Home menu' }).click();
        await expect(page.getByRole('menu')).toBeVisible();
      },
      async (page) => {
        const items = page.getByRole('menu').getByRole('menuitem');
        const count = await items.count();
        for (let i = 0; i < count; i += 1) {
          const box = await items.nth(i).boundingBox();
          if (!box) continue;
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(260);
        }
      },
      (page) => boxOf(page, '[role="menu"]', 12),
    );
  });

  test('new-pane-dialog', async ({ browser }) => {
    await capture(
      browser,
      'new-pane-dialog',
      'Opening the New Pane dialog',
      async () => {},
      async (page) => {
        await page.getByRole('button', { name: `New pane in ${project.name}` }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
      },
      (page) => boxOf(page, '[role="dialog"]', 48),
    );
  });

  test('dialog-button-press', async ({ browser }) => {
    await capture(
      browser,
      'dialog-button-press',
      'Pressing and releasing the dialog’s primary button',
      async (page) => {
        await page.getByRole('button', { name: `New pane in ${project.name}` }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
      },
      async (page) => {
        const cancel = page.getByRole('dialog').getByRole('button', { name: 'Cancel' });
        const box = await cancel.boundingBox();
        if (!box) throw new Error('Cancel button has no box');
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(400);
        await page.mouse.down();
        await page.waitForTimeout(1400);
        await page.mouse.up();
      },
      async (page) => {
        const footer = await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).boundingBox();
        return footer ? frameRegion({ ...footer, width: footer.width + 220 }, 44) : FULL_VIEWPORT;
      },
      'before',
    );
  });

});
