import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// D-385 and review F-1: Notify's round and its cards start with nothing picked, and words typed
// with no pick still go on their own as a reply (D-245).
const fixture = path.resolve('tests/fixtures/notify-cards.tsx');

async function open(page: Page, query: string) {
  await page.route('**/notify-cards.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto(`/notify-cards.html?${query}`);
  await expect(page.getByText('Which session store should the refactor use?').first()).toBeVisible();
}
const commands = (page: Page) => page.evaluate(() => window.qaCommands);

test.describe("Notify's round", () => {
  test('opens with nothing picked; Enter sends nothing until a pick or a typed reply', async ({ page }) => {
    await open(page, 'surface=round');
    const round = page.getByTestId('notify-round');
    await expect(round.getByRole('option', { selected: true })).toHaveCount(0);
    await expect(round.getByRole('button', { name: 'Pick a choice' })).toBeDisabled();
    await page.keyboard.press('Enter');
    expect(await commands(page)).toEqual([]);

    await page.keyboard.press('Tab');
    await round.getByRole('textbox', { name: 'Note' }).fill('Which one supports revoking a session?');
    await expect(round.getByRole('button', { name: /Send to Claude/ })).toBeEnabled();
    await page.keyboard.press('Enter');
    await expect.poll(() => commands(page)).toEqual([{ type: 'answer', id: 'q1', answer: { picks: [], text: 'Which one supports revoking a session?' } }]);
  });

  test('an approval with no Y or N sends a typed reply on its own', async ({ page }) => {
    await open(page, 'surface=round&ui=approve');
    const round = page.getByTestId('notify-round');
    await expect(round.getByRole('button', { name: 'Press Y or N' })).toBeDisabled();
    await page.keyboard.press('Tab');
    await round.getByRole('textbox', { name: 'Note' }).fill('Is staging empty right now?');
    await round.getByRole('button', { name: /Send to Claude/ }).click();
    await expect.poll(() => commands(page)).toEqual([{ type: 'answer', id: 'q1', answer: { picks: [], text: 'Is staging empty right now?' } }]);
  });

  test('a question that takes only its options still needs a pick', async ({ page }) => {
    await open(page, 'surface=round&optionsOnly=1');
    const round = page.getByTestId('notify-round');
    await page.keyboard.press('Tab');
    await round.getByRole('textbox', { name: 'Note' }).fill('why?');
    await expect(round.getByRole('button', { name: 'Pick a choice' })).toBeDisabled();
    await page.keyboard.press('Enter');
    expect(await commands(page)).toEqual([]);
  });
});

test.describe('Notify card', () => {
  test('opens with nothing picked; Send waits for a pick or a typed reply, and sends the reply alone', async ({ page }) => {
    await open(page, 'surface=card');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await expect(page.getByRole('button', { pressed: true })).toHaveCount(0);
    await expect(page.getByText('Recommended', { exact: true })).toBeVisible();
    await expect(send).toBeDisabled();
    await page.getByPlaceholder(/Add a note for Claude/).fill('Which one supports revoking a session?');
    await expect(send).toBeEnabled();
    await send.click();
    await expect.poll(() => commands(page)).toEqual([{ type: 'answer', id: 'q1', answer: { picks: [], text: 'Which one supports revoking a session?' } }]);
  });

  test('a pick with a note sends both', async ({ page }) => {
    await open(page, 'surface=card');
    await page.getByRole('button', { name: /Keep Redis/ }).click();
    await page.getByPlaceholder(/Add a note for Claude/).fill('only for now');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => commands(page)).toEqual([{ type: 'answer', id: 'q1', answer: { picks: ['Keep Redis'], text: 'only for now' } }]);
  });
});

// T-11: the card's own Enter (pointer over the card, keyboard outside its field) obeys the same
// rules as Send, on every form the card takes.
test.describe("Notify card's Enter", () => {
  for (const form of ['docked', 'strip', 'inbox'] as const) {
    test(`${form}: sends a typed reply with no pick after leaving the field`, async ({ page }) => {
      await open(page, `surface=card&form=${form}`);
      const card = page.getByTestId('notify-card');
      if (form === 'inbox') await card.getByRole('button', { name: 'Details' }).click();
      await card.getByPlaceholder(/Add a note for Claude/).fill('Which one supports revoking a session?');
      await expect(card.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
      // Leave the field by clicking the title; the pointer stays over the card.
      await card.getByText('Which session store should the refactor use?').click();
      await expect(card.getByPlaceholder(/Add a note for Claude/)).not.toBeFocused();
      await page.keyboard.press('Enter');
      await expect.poll(() => commands(page)).toEqual([{ type: 'answer', id: 'q1', answer: { picks: [], text: 'Which one supports revoking a session?' } }]);
    });
  }

  test('sends nothing when the question takes only its options', async ({ page }) => {
    await open(page, 'surface=card&optionsOnly=1');
    const card = page.getByTestId('notify-card');
    await card.getByPlaceholder(/Add a note for Claude/).fill('why?');
    await card.getByText('Which session store should the refactor use?').click();
    await page.keyboard.press('Enter');
    await expect(card.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    expect(await commands(page)).toEqual([]);
  });

  test('sends a pick with its note', async ({ page }) => {
    await open(page, 'surface=card');
    const card = page.getByTestId('notify-card');
    await card.getByPlaceholder(/Add a note for Claude/).fill('only for now');
    await card.getByText('Which session store should the refactor use?').click();
    await page.keyboard.press('2');
    await page.keyboard.press('Enter');
    await expect.poll(() => commands(page)).toEqual([{ type: 'answer', id: 'q1', answer: { picks: ['Keep Redis'], text: 'only for now' } }]);
  });
});

test.describe('Notify strip window', () => {
  test('Dismiss with the keyboard moves focus to the next card, then to the window when none is left', async ({ page }) => {
    await open(page, 'surface=strip-window');
    await page.getByTestId('notify-dismiss').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => commands(page)).toEqual([{ type: 'dismiss', id: 'q1' }]);
    const next = page.getByTestId('notify-card');
    await expect(next).toContainText('Ship the migration tonight?');
    await expect(next).toBeFocused();

    await page.getByTestId('notify-dismiss').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('notify-card')).toHaveCount(0);
    await expect(page.getByTestId('notify-window')).toBeFocused();
  });
});
