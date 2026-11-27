import { expect, test, type Page } from '@playwright/test';

// Collapsing any agent-message card (T-139), on the real cards: the chevron, a preview click,
// a jump up into a collapsed card, what is kept across reloads, and a chat with no tab id.
const card = (page: Page, ref = 'M-1') => page.locator(`[data-testid="agent-message-card"][data-ref="${ref}"]`);
const stored = (page: Page) => page.evaluate(() => window.localStorage.getItem('pane.chat.agentMessageOpen'));

test.describe('collapsing an agent-message card (T-139)', () => {
  test('the chevron collapses the card to its header rows and previews, and opens it again', async ({ page }) => {
    await page.goto('/renderer-tests/agent-message-card.html');
    const collapse = card(page).getByRole('button', { name: 'Collapse message M-1' });
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await collapse.click();
    await expect(card(page)).toHaveAttribute('data-collapsed', 'preview');
    const expand = card(page).getByRole('button', { name: 'Expand message M-1' });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect(card(page).getByText('Answered')).toBeVisible();
    // The previews are click shortcuts with short names; the chevron is the one disclosure control.
    const previews = card(page).getByTestId('agent-message-preview');
    await expect(previews).toHaveCount(2);
    await expect(card(page).getByRole('button', { name: 'Show all of message M-1' })).not.toHaveAttribute('aria-expanded', /.*/);
    await expect(card(page).getByRole('button', { name: 'Show all of reply M-2' })).toHaveAttribute('tabindex', '-1');
    await expect(card(page).locator('[aria-expanded]')).toHaveCount(1);
    await expand.press('Enter');
    await expect(card(page)).not.toHaveAttribute('data-collapsed', 'preview');
    await expect(card(page).getByRole('button', { name: 'Collapse message M-1' })).toBeFocused();
  });

  test('clicking a preview opens the card and moves focus to its chevron', async ({ page }) => {
    await page.goto('/renderer-tests/agent-message-card.html');
    await card(page).getByRole('button', { name: 'Collapse message M-1' }).click();
    await card(page).getByRole('button', { name: 'Show all of reply M-2' }).click();
    await expect(card(page)).not.toHaveAttribute('data-collapsed', 'preview');
    await expect(card(page).getByRole('button', { name: 'Collapse message M-1' })).toBeFocused();
  });

  test('a jump up to the reply opens a collapsed card and brings it into view', async ({ page }) => {
    await page.goto('/renderer-tests/agent-message-card.html');
    await card(page).getByRole('button', { name: 'Collapse message M-1' }).click();
    const jump = page.getByRole('button', { name: /replied to M-1 above/ });
    await jump.scrollIntoViewIfNeeded();
    await expect(card(page)).not.toBeInViewport();
    await jump.click();
    await expect(card(page)).not.toHaveAttribute('data-collapsed', 'preview');
    await expect(card(page)).toBeInViewport();
    await expect(card(page)).toBeFocused();
  });

  test('a card\'s choice is kept per tab and M-n across a reload; a card with no M-n isn\'t stored', async ({ page }) => {
    await page.goto('/renderer-tests/agent-message-card.html');
    await card(page).getByRole('button', { name: 'Collapse message M-1' }).click();
    const todos = page.locator('[data-testid="agent-message-card"][data-anchor-id="todos-line"]');
    await todos.getByRole('button', { name: 'Collapse message' }).click();
    await expect(todos).toHaveAttribute('data-collapsed', 'preview');
    expect(JSON.parse((await stored(page)) ?? '{}')).toEqual({ 'daily:M-1': false });
    await page.reload();
    await expect(card(page)).toHaveAttribute('data-collapsed', 'preview');
    await expect(todos).not.toHaveAttribute('data-collapsed', 'preview');
  });

  test('with no tab id the chevron still works, kept only while the card is shown', async ({ page }) => {
    await page.goto('/renderer-tests/agent-message-card.html?tab=none');
    await card(page).getByRole('button', { name: 'Collapse message M-1' }).click();
    await expect(card(page)).toHaveAttribute('data-collapsed', 'preview');
    expect(await stored(page)).toBeNull();
    await card(page).getByRole('button', { name: 'Expand message M-1' }).click();
    await expect(card(page)).not.toHaveAttribute('data-collapsed', 'preview');
  });
});
