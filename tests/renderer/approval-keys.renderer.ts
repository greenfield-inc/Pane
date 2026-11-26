import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window { approvalKeysTest: { commands: () => Array<{ type: string; id?: string; answer?: { picks?: string[]; text?: string } }>; run: (id: string) => void; view: () => string } }
}

const commands = (page: Page) => page.evaluate(() => window.approvalKeysTest.commands());
const question = (page: Page, at: number) => page.getByTestId('approval-question').nth(at);
const option = (page: Page, at: number, label: string) => question(page, at).getByRole('radio', { name: label });

test.describe('the approval column (D-381)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/renderer-tests/approval-keys.html?surface=column');
    await expect(page.getByTestId('approval-pager')).toHaveText('1 of 2');
  });

  test('each question is one Tab stop: ↑↓ move and pick, Tab goes to the next question, then the reply box', async ({ page }) => {
    // Nothing is picked at first (D-385), so the first option is the group's one stop.
    await expect(question(page, 0).getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(option(page, 0, '⌘/ everywhere Recommended')).toHaveAttribute('tabindex', '0');
    await expect(option(page, 0, 'Both')).toHaveAttribute('tabindex', '-1');
    await option(page, 0, '⌘/ everywhere Recommended').focus();
    await page.keyboard.press('ArrowDown');
    await expect(option(page, 0, '? outside text fields only')).toBeFocused();
    await expect(option(page, 0, '? outside text fields only')).toHaveAttribute('aria-checked', 'true');
    await expect(option(page, 0, '⌘/ everywhere Recommended')).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    // Wraps from the first to the last.
    await expect(option(page, 0, 'Both')).toBeFocused();
    await expect(option(page, 0, 'Both')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Tab');
    await expect(option(page, 1, 'Yes, a small dot Recommended')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('approval-reply-box')).toBeFocused();
  });

  test('Space picks the focused option and never clears it', async ({ page }) => {
    const picked = option(page, 1, 'Yes, a small dot Recommended');
    await picked.focus();
    await page.keyboard.press('Space');
    await expect(picked).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await expect(option(page, 1, 'No marker')).toHaveAttribute('aria-checked', 'true');
    await expect(picked).toHaveAttribute('aria-checked', 'false');
  });

  test('← → on a focused option stay in the approval; with no option focused they page', async ({ page }) => {
    await option(page, 0, '⌘/ everywhere Recommended').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('approval-pager')).toHaveText('1 of 2');
    await expect(option(page, 0, '⌘/ everywhere Recommended')).toBeFocused();
    await page.getByTestId('approval-title').click();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('approval-pager')).toHaveText('2 of 2');
  });

  test('⌘↩ sends from an option, with the picks', async ({ page }) => {
    await option(page, 0, 'Both').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    await expect(option(page, 1, 'Yes, a small dot Recommended')).toBeFocused();
    await page.keyboard.press('Space');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect.poll(() => commands(page)).toEqual([{ type: 'answer', id: 'q12', answer: { picks: ['Both', 'Yes, a small dot'] } }]);
  });

  test('⌘↩ sends once from the reply box, with the words', async ({ page }) => {
    await page.getByTestId('approval-reply-box').fill('only if undoable');
    await page.getByTestId('approval-reply-box').press('ControlOrMeta+Enter');
    await expect.poll(() => commands(page)).toHaveLength(1);
    expect((await commands(page))[0].answer?.text).toBe('only if undoable');
  });

  test('typing in the reply box and the chat composer changes nothing else; ⌘↩ in the composer is the composer\'s', async ({ page }) => {
    const box = page.getByTestId('approval-reply-box');
    await box.click();
    await page.keyboard.type('j k 1 r g');
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']) await page.keyboard.press(key);
    await expect(box).toHaveValue('j k 1 r g ');
    await expect(page.getByTestId('approval-pager')).toHaveText('1 of 2');
    await expect(question(page, 0).getByRole('radio', { checked: true })).toHaveCount(0);
    const composer = page.getByLabel('Chat composer');
    await composer.click();
    await page.keyboard.type('j k 1 r g');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(composer).toHaveValue('j k 1 r g');
    await expect(page.getByTestId('approval-pager')).toHaveText('1 of 2');
    expect(await commands(page)).toEqual([]);
  });

  test('⇧↩ sends the recommended option of each question when nothing is picked, and the chip names it (T-88)', async ({ page }) => {
    await expect(question(page, 0).getByTestId('approval-recommended')).toHaveText('Recommended · ⇧↩ sends');
    // Nothing is preselected (D-385): the key is the person's choice.
    await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
    await option(page, 1, 'No marker').focus();
    await page.keyboard.press('Shift+Enter');
    await expect.poll(() => commands(page)).toEqual([{ type: 'answer', id: 'q12', answer: { picks: ['⌘/ everywhere', 'Yes, a small dot'] } }]);
  });

  test('⇧↩ does nothing special once the person picked: ⌘↩ sends their pick (T-88)', async ({ page }) => {
    await option(page, 0, 'Both').focus();
    await page.keyboard.press('Space');
    await expect(question(page, 0).getByTestId('approval-recommended')).toHaveText('Recommended');
    await page.keyboard.press('Shift+Enter');
    // Not clicked by it either: the pick stays.
    await expect(option(page, 0, 'Both')).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(200);
    expect(await commands(page)).toEqual([]);
  });

  test('⇧↩ never fires while typing, in the reply box or the chat composer (T-88)', async ({ page }) => {
    const box = page.getByTestId('approval-reply-box');
    await box.click();
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('x');
    await expect(box).toHaveValue('\nx');
    await page.getByLabel('Chat composer').click();
    await page.keyboard.press('Shift+Enter');
    await page.waitForTimeout(200);
    expect(await commands(page)).toEqual([]);
  });

  test('the palette\'s Next and Previous Approval page the approval shown', async ({ page }) => {
    await page.getByLabel('Chat composer').click();
    await page.evaluate(() => window.approvalKeysTest.run('next-approval'));
    await expect(page.getByTestId('approval-pager')).toHaveText('2 of 2');
    await page.evaluate(() => window.approvalKeysTest.run('previous-approval'));
    await expect(page.getByTestId('approval-pager')).toHaveText('1 of 2');
  });

  test('Send and the pager name their keys in tooltips', async ({ page }) => {
    await page.getByTestId('approval-send').hover();
    await expect(page.getByTestId('approval-key-tip').filter({ hasText: 'Send' })).toBeVisible();
    await expect(page.getByTestId('approval-key-tip').filter({ hasText: 'Send' })).toContainText(/↩|Enter/);
    await page.getByRole('button', { name: 'Next approval' }).hover();
    await expect(page.getByTestId('approval-key-tip').filter({ hasText: 'Next approval' })).toContainText('→');
  });
});

test.describe('the Approvals screen (D-381)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/renderer-tests/approval-keys.html?surface=screen');
    await expect(page.getByTestId('approvals-row')).toHaveCount(3);
  });

  const row = (page: Page, at: number) => page.getByTestId('approvals-row').nth(at);

  test('the list is one Tab stop; ↑↓ move and the approval follows; ↩ goes in, Esc comes back', async ({ page }) => {
    await expect(row(page, 0)).toHaveAttribute('tabindex', '0');
    await expect(row(page, 1)).toHaveAttribute('tabindex', '-1');
    await row(page, 0).focus();
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 1)).toBeFocused();
    await expect(row(page, 1)).toHaveAttribute('aria-current', 'true');
    const id = await row(page, 1).getAttribute('data-item-id');
    await expect(page.getByTestId('approvals-beside').getByTestId('approval-column')).toHaveAttribute('data-item-id', id ?? '');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('approvals-beside').getByRole('radio').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(row(page, 1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(row(page, 0)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('approvals-beside').getByRole('radio').first()).toBeFocused();
  });

  test('with the list focused, the tab keys switch Waiting and Done today; in the approval they walk its tabs', async ({ page }) => {
    await row(page, 0).focus();
    await page.keyboard.press('ControlOrMeta+Alt+BracketRight');
    await expect(page.getByRole('tab', { name: /Done today/ })).toHaveAttribute('aria-selected', 'true');
    // Focus stays in the list, on the Done today list's row.
    await expect(row(page, 0)).toBeFocused();
    await page.keyboard.press('ControlOrMeta+Alt+BracketLeft');
    await expect(page.getByRole('tab', { name: /Waiting/ })).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 0)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('approvals-beside').getByRole('radio').first()).toBeFocused();
    await page.keyboard.press('ControlOrMeta+Alt+BracketRight');
    await expect(page.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
    // Focus moves to the tab shown, out of the Summary's frame, so the next tab key still reaches Pane.
    await expect(page.getByRole('tab', { name: 'Summary' })).toBeFocused();
    await page.keyboard.press('ControlOrMeta+Alt+BracketLeft');
    await expect(page.getByRole('tab', { name: 'Decide' })).toHaveAttribute('aria-selected', 'true');
  });

  test('Group by is a Tab stop with an arrow-key menu', async ({ page }) => {
    await page.getByTestId('approvals-sort').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menu', { name: 'Group by' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Group by' })).toHaveCount(0);
  });

  test('the palette\'s Group By opens the menu; ⇧⌘A closes Approvals', async ({ page }) => {
    await page.evaluate(() => window.approvalKeysTest.run('approvals-group-by'));
    await expect(page.getByRole('menu', { name: 'Group by' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Group by' })).toHaveCount(0);
    expect(await page.evaluate(() => window.approvalKeysTest.view())).toBe('notify');
    await row(page, 0).focus();
    await page.keyboard.press('ControlOrMeta+Shift+KeyA');
    await expect.poll(() => page.evaluate(() => window.approvalKeysTest.view())).not.toBe('notify');
  });

  test('typing in the reply box takes no list keys', async ({ page }) => {
    const box = page.getByTestId('approval-reply-box');
    await box.click();
    await page.keyboard.type('j k 1 r g');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(box).toHaveValue('j k 1 r g');
    await expect(box).toBeFocused();
    await expect(row(page, 0)).toHaveAttribute('aria-current', 'true');
  });
});

test.describe('a Session chat\'s approval key (D-381)', () => {
  /** ⌥⌘A on macOS; Ctrl+K, then Ctrl+A elsewhere (Ctrl+Alt+A is AltGr on many layouts). */
  async function openSessionApprovalKey(page: Page) {
    if (await page.evaluate(() => navigator.platform.toUpperCase().includes('MAC'))) {
      await page.keyboard.press('Meta+Alt+KeyA');
      return;
    }
    await page.keyboard.press('Control+KeyK');
    await page.keyboard.press('Control+KeyA');
  }

  test('opens the Session\'s approval on its first question, and pressed again goes back to the chat with the draft kept', async ({ page }) => {
    await page.goto('/renderer-tests/approval-keys.html?surface=session');
    const composer = page.getByLabel('Chat composer');
    await composer.click();
    await page.keyboard.type('a half-written reply');
    await expect(page.getByTestId('approval-column')).toHaveCount(0);

    await openSessionApprovalKey(page);
    const column = page.getByTestId('approval-column');
    await expect(column).toBeVisible();
    // The newest waiting approval opens (T-88), with focus on its first question's option.
    await expect(page.getByTestId('approval-title')).toHaveText('Q-12: Which key opens the keyboard shortcut sheet?');
    await expect(column.getByRole('radio').first()).toBeFocused();

    await openSessionApprovalKey(page);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('a half-written reply');
    // The approval stays open beside the chat; the key only moved focus.
    await expect(column).toBeVisible();

    // And once more: back into the open approval.
    await openSessionApprovalKey(page);
    await expect(column.getByRole('radio').first()).toBeFocused();
  });

  test('with nothing waiting in the Session, says so and leaves focus in the chat', async ({ page }) => {
    await page.goto('/renderer-tests/approval-keys.html?surface=session&waiting=none');
    const composer = page.getByLabel('Chat composer');
    await composer.click();
    await page.keyboard.type('draft');
    await openSessionApprovalKey(page);
    await expect(page.getByTestId('key-hint')).toHaveText('Nothing in this Session is waiting on you.');
    await expect(page.getByTestId('approval-column')).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('draft');
  });
});

test.describe('⇧↩ with a question that has no recommendation (T-88)', () => {
  test('sends nothing and says which question to pick', async ({ page }) => {
    await page.goto('/renderer-tests/approval-keys.html?surface=column&unrecommended');
    await expect(page.getByTestId('approval-pager')).toHaveText('1 of 2');
    await expect(question(page, 0).getByTestId('approval-recommended')).toHaveText('Recommended');
    await option(page, 0, '⌘/ everywhere Recommended').focus();
    await page.keyboard.press('Shift+Enter');
    await expect(page.getByTestId('approval-reply-hint')).toHaveText(/^Question 2 has no recommended option: pick, then .+ sends\.$/);
    expect(await commands(page)).toEqual([]);
    // Picking clears the hint.
    await page.keyboard.press('Space');
    await expect(page.getByTestId('approval-reply-hint')).toHaveText(/^Pick an option/);
  });
});
