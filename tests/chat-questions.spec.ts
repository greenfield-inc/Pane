import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// D-230: a question card with several questions takes them one at a time.
const fixture = path.resolve('tests/fixtures/chat-tab-composer.tsx');
const shots = process.env.PANE_VERIFY_DIR;

async function open(page: Page, query: string) {
  await page.route('**/chat-tab-composer.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto(`/chat-tab-composer.html?${query}`);
  await expect(page.getByRole('region', { name: 'Agent question' })).toBeVisible();
}
const width = () => test.info().project.name === 'phone' ? 360 : 640;
const answers = (page: Page) => page.evaluate(() => window.qaAnswers);

test('two questions are asked one at a time, with a review before Answer', async ({ page }) => {
  await open(page, `questions=2&width=${width()}`);
  const card = page.getByRole('region', { name: 'Agent question' });
  await expect(card).toContainText('1 of 2');
  await expect(card).toContainText('#1491 P1');
  await expect(card).not.toContainText('Versioning');
  await expect(card.getByRole('button', { name: 'Next' })).toBeDisabled();
  await card.getByRole('radio', { name: /Wait for plan v9/ }).focus();
  await page.keyboard.press('1');
  await expect(card.getByRole('radio', { name: /Ready: start agent review/ })).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(card).toContainText('2 of 2');
  await expect(card.getByRole('button', { name: 'Answer' })).toBeVisible();
  await expect(card.getByRole('list', { name: 'Your answers' })).toContainText('Ready: start agent review (Recommended)');
  await card.getByRole('radio', { name: /Change some/ }).check();
  await card.getByRole('textbox', { name: /Other/ }).fill('Keep the old metric name');
  if (shots) await page.screenshot({ path: `${shots}/questions-review-${test.info().project.name}.png` });
  await card.getByRole('button', { name: 'Back' }).click();
  await expect(card).toContainText('1 of 2');
  await card.getByRole('button', { name: 'Next' }).click();
  await card.getByRole('button', { name: 'Answer' }).click();
  await expect.poll(() => answers(page)).toEqual([{ action: 'accept', content: { question_0: 'Ready', question_1: 'Some', question_1_custom: 'Keep the old metric name' } }]);
});

test('the keyboard alone answers both questions: number, Enter, number, Enter (review F-2)', async ({ page }) => {
  await open(page, `questions=2&width=${width()}`);
  const card = page.getByRole('region', { name: 'Agent question' });
  await card.getByRole('radio', { name: /Wait for plan v9/ }).focus();
  await page.keyboard.press('1');
  await page.keyboard.press('Enter');
  await expect(card).toContainText('2 of 2');
  // Focus moved into the new question, so its keys still reach the card.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[aria-label="Agent question"]'))).toBe(true);
  await page.keyboard.press('2');
  // The focus ring moves to the option the number picked.
  await expect(card.getByRole('radio', { name: /Change some/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => answers(page)).toEqual([{ action: 'accept', content: { question_0: 'Ready', question_1: 'Some' } }]);
});

test('a form with no choices is still one question at a time, and Skip skips one (review F-4)', async ({ page }) => {
  await open(page, `questions=text&width=${width()}`);
  const card = page.getByRole('region', { name: 'Agent question' });
  await expect(card).toContainText('1 of 2');
  await expect(card.getByRole('spinbutton')).toHaveCount(0);
  await card.getByRole('textbox', { name: /Project name/ }).fill('atlas');
  await page.keyboard.press('Enter');
  await expect(card).toContainText('2 of 2');
  await expect(card.getByRole('spinbutton', { name: /Keep logs for/ })).toBeFocused();
  await card.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect.poll(() => answers(page)).toEqual([{ action: 'accept', content: { name: 'atlas' } }]);
});

test('Skip passes over one question, not the whole card', async ({ page }) => {
  await open(page, `questions=2&width=${width()}`);
  const card = page.getByRole('region', { name: 'Agent question' });
  await card.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(card).toContainText('2 of 2');
  await expect(card.getByRole('list', { name: 'Your answers' })).toContainText('Skipped');
  await card.getByRole('radio', { name: /Take all four/ }).check();
  await card.getByRole('button', { name: 'Answer' }).click();
  await expect.poll(() => answers(page)).toEqual([{ action: 'accept', content: { question_1: 'All' } }]);
});

test('skipping every question declines the form', async ({ page }) => {
  await open(page, `questions=2&width=${width()}`);
  const card = page.getByRole('region', { name: 'Agent question' });
  await card.getByRole('button', { name: 'Skip', exact: true }).click();
  await card.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect.poll(() => answers(page)).toEqual([{ action: 'decline' }]);
});

test('one question has no stepper', async ({ page }) => {
  await open(page, `questions=1&width=${width()}`);
  const card = page.getByRole('region', { name: 'Agent question' });
  await expect(card).not.toContainText('1 of 1');
  await expect(card.getByRole('button', { name: 'Next' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Answer' })).toBeVisible();
});

if (shots) for (const theme of ['light', 'dark']) {
  test(`screenshots: the first of two questions (${theme})`, async ({ page }) => {
    await open(page, `questions=2&width=${width()}&theme=${theme}`);
    await page.screenshot({ path: `${shots}/questions-step1-${theme}-${test.info().project.name}.png` });
  });
}
