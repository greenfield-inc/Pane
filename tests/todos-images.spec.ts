import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock, type TodosMockHooks } from './electronApiMock';
import { todoFixtures } from './todosThreadFixture';

declare global {
  interface Window {
    __paneTestElectronMock: TodosMockHooks;
  }
}

// To-dos round 8 (T-5), renderer only: images on a to-do and in comments. A pasted image shows as a
// thumbnail in its comment; an agent's image attach shows inline; a thumbnail opens big in the split,
// fitted, and a click shows it at actual size; a file dropped on the split is attached straight away.
const SHOTS = process.env.TODOS_SHOTS_DIR;

/** A 1600×1000 picture, larger than the split, so fitting it shows. */
const BIG_IMAGE = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#4f7cff"/><stop offset="1" stop-color="#18b37e"/></linearGradient></defs>'
  + '<rect width="1600" height="1000" fill="url(#g)"/><rect x="120" y="120" width="900" height="120" rx="20" fill="#fff" opacity=".85"/><rect x="120" y="300" width="1360" height="560" rx="28" fill="#fff" opacity=".6"/></svg>',
).toString('base64')}`;

async function open(page: Page, theme: 'light-rounded' | 'dark') {
  const { snapshot, detail, notify } = todoFixtures('prototype');
  const now = Date.now();
  // planner attached a screenshot with `runpane todos attach T-12 checkout.png`.
  detail.attachments[0].attachments.push({ id: 6, todoNumber: 12, kind: 'image', target: '/tmp/shots/checkout.png', label: 'checkout.png', addedBy: 'planner', source: 'attached', addedAt: now - 3 * 60_000, machine: 'devbox' });
  detail.activity.push({ id: 400, todoNumber: 12, kind: 'event', authorKind: 'agent', authorName: 'planner', body: 'planner attached image: checkout.png', createdAt: now - 3 * 60_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await installElectronApiMock(page, {
    initialProjects: [], initialSessions: [], initialConfig: { theme, appearanceMode: 'fixed' }, notifySnapshot: notify,
    todos: { snapshot, details: { 12: detail }, imageDataUrl: BIG_IMAGE, recordActivity: true, docs: { '/tmp/plan.html': { kind: 'text', path: '/tmp/plan.html', text: '# Invoice PDFs: plan' } } },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('todos-nav').click();
  await page.getByTestId('todo-row').first().click();
  await expect(page.getByTestId('todo-chat')).toBeVisible();
  // The composer takes files from the thread once it is mounted, after the page's skeleton.
  await expect(page.getByTestId('todo-composer-input')).toBeVisible();
}

function todoActs(page: Page) {
  return page.evaluate(() => window.__paneTestElectronMock.getInvokeCalls('todos:act').map((call) => call.args[0]));
}

/** Pastes (or drops, on `selector`) a 1200×800 PNG named `name`, as the clipboard or Finder hands one over. */
async function sendPng(page: Page, selector: string, name: string, how: 'paste' | 'drop') {
  await page.evaluate(async ({ selector: target, name: fileName, how: kind }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 800;
    const context = canvas.getContext('2d');
    if (context) { context.fillStyle = '#e8a33d'; context.fillRect(0, 0, 1200, 800); }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The test image could not be made.');
    const data = new DataTransfer();
    data.items.add(new File([blob], fileName, { type: 'image/png' }));
    const element = document.querySelector(target);
    if (!element) throw new Error(`Nothing matches ${target}.`);
    if (kind === 'paste') {
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    } else {
      element.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }
  }, { selector, name, how });
}

/** The image loaded: it has its natural size. */
async function loaded(page: Page, selector: string) {
  await expect.poll(() => page.locator(selector).first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
}

for (const theme of ['light-rounded', 'dark'] as const) {
  const mode = theme === 'dark' ? 'dark' : 'light';

  test(`T-5 images in the thread and the split (${mode})`, async ({ page }) => {
    await open(page, theme);
    const chat = page.getByTestId('todo-chat');

    // An agent's image attach stays out of folds and runs: one line with the thumbnail.
    const agentImage = chat.locator('[data-testid="todo-thread-event"][data-image="checkout.png"]');
    await expect(agentImage).toContainText('planner attached image');
    await loaded(page, '[data-image="checkout.png"] [data-testid="todo-thread-image"] img');

    // Paste an image into the composer, then send it with words.
    await sendPng(page, '[data-testid="todo-composer-input"]', 'screenshot.png', 'paste');
    await expect(page.getByTestId('todo-composer-attached')).toContainText('screenshot.png');
    await page.getByTestId('todo-composer-input').fill('The total is off by a cent here');
    await page.getByTestId('todo-composer-input').press('ControlOrMeta+Enter');
    await expect(page.getByTestId('todo-composer-input')).toHaveValue('');
    const acts = await todoActs(page);
    expect(acts).toContainEqual({ kind: 'attach', number: 12, target: '/tmp/pane-images/screenshot.png', label: 'screenshot.png' });
    expect(acts).toContainEqual({ kind: 'comment', number: 12, body: 'The total is off by a cent here\n\nAttached screenshot.png: /tmp/pane-images/screenshot.png' });

    // The comment shows its words and the thumbnail, not the Attached line; its attach event doesn't repeat the image.
    const comment = chat.getByTestId('todo-thread-comment').filter({ hasText: 'The total is off by a cent here' });
    await expect(comment.locator('[data-testid="todo-thread-image"][data-path="/tmp/pane-images/screenshot.png"]')).toBeVisible();
    await expect(comment).not.toContainText('Attached screenshot.png');
    await expect(chat.locator('[data-image="screenshot.png"]')).toHaveCount(0);
    await loaded(page, '[data-path="/tmp/pane-images/screenshot.png"] img');
    const thumb = await comment.locator('[data-testid="todo-thread-image"] img').boundingBox();
    expect(thumb && thumb.width <= 240 && thumb.height <= 160).toBe(true);
    await page.getByTestId('todo-page-scroll').evaluate((node) => { node.scrollTop = node.scrollHeight; });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/T5-thread-${mode}.png` });

    // A click on the thumbnail opens its attachment tab, the image fitted to the split.
    await comment.getByTestId('todo-thread-image').click();
    const view = page.getByTestId('todo-split').getByTestId('autopilot-image-doc');
    await expect(view).toHaveAttribute('data-fit', 'contain');
    await loaded(page, '[data-testid="autopilot-image-doc"] img');
    const fitted = await view.evaluate((box) => {
      const image = box.querySelector('img');
      const outer = box.getBoundingClientRect();
      const inner = image?.getBoundingClientRect();
      return inner ? { inside: inner.width <= outer.width && inner.height <= outer.height, centered: Math.abs((inner.left + inner.right) / 2 - (outer.left + outer.right) / 2) < 2 } : null;
    });
    expect(fitted).toEqual({ inside: true, centered: true });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/T5-split-fit-${mode}.png` });

    // A click shows it at actual size, scrolling; another fits it again.
    await view.locator('[role="button"]').click();
    await expect(view).toHaveAttribute('data-fit', 'actual');
    const scrolls = await view.locator('[role="button"]').evaluate((box) => box.scrollWidth > box.clientWidth);
    expect(scrolls).toBe(true);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/T5-split-actual-${mode}.png` });
    await view.locator('[role="button"]').click();
    await expect(view).toHaveAttribute('data-fit', 'contain');

    // The agent's thumbnail opens its own tab too.
    await agentImage.getByTestId('todo-thread-image').click();
    await expect(page.getByTestId('todo-split-attachment')).toHaveAttribute('data-attachment', '6');
  });
}

test('T-5 a file dropped on the split is attached to the to-do, with no comment', async ({ page }) => {
  await open(page, 'light-rounded');
  await expect(page.getByTestId('todo-split')).toBeVisible();
  await sendPng(page, '[data-testid="todo-split"]', 'dropped.png', 'drop');
  await expect.poll(async () => (await todoActs(page)).filter((act) => act.kind === 'attach')).toEqual([
    { kind: 'attach', number: 12, target: '/tmp/pane-images/dropped.png', label: 'dropped.png' },
  ]);
  expect((await todoActs(page)).some((act) => act.kind === 'comment')).toBe(false);
  // Its tab shows, and the thread shows the image attached.
  await expect(page.getByTestId('todo-split').getByTestId('autopilot-image-doc')).toBeVisible();
  await expect(page.getByTestId('todo-chat').locator('[data-image="dropped.png"] [data-testid="todo-thread-image"]')).toBeVisible();
});

test('T-5 a file dropped on the thread goes to the composer', async ({ page }) => {
  await open(page, 'light-rounded');
  await sendPng(page, '[data-testid="todo-chat"]', 'from-thread.png', 'drop');
  await expect(page.getByTestId('todo-composer-attached')).toContainText('from-thread.png');
  expect((await todoActs(page)).some((act) => act.kind === 'comment')).toBe(false);
});

test('T-5 a file dropped on a reply goes with that reply, not the main composer', async ({ page }) => {
  await open(page, 'light-rounded');
  const reply = page.getByTestId('todo-thread-reply-box').first();
  await reply.scrollIntoViewIfNeeded();
  await sendPng(page, '[data-testid="todo-thread-reply-box"]', 'for-reply.png', 'drop');
  await expect(reply).toContainText('for-reply.png');
  await expect(page.getByTestId('todo-composer')).not.toContainText('for-reply.png');
});
