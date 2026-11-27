import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// #1705: @ files, $ skills and / in one menu above the message box.
const fixture = path.resolve('tests/fixtures/chat-tab-composer.tsx');
const shots = process.env.PANE_VERIFY_DIR;

async function open(page: Page, query = '') {
  await page.route('**/chat-tab-composer.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto(`/chat-tab-composer.html?mentions=all&skills=1&width=640&${query}`);
  const input = page.getByRole('textbox', { name: 'Message Claude' });
  await expect(input).toBeVisible();
  return input;
}
const sent = (page: Page) => page.evaluate(() => window.qaSent.map(({ text }) => text));
const options = (page: Page) => page.getByRole('option');
const caret = (page: Page) => page.evaluate(() => document.querySelector('textarea')!.selectionStart);

test('@ picks a file: the box shows the highlighted path and sends it', async ({ page }) => {
  const input = await open(page);
  await input.pressSequentially('Why does @comp');
  await expect(page.getByRole('listbox', { name: 'Files' })).toBeVisible();
  await expect(options(page).first()).toHaveText('ChatComposerControls.tsxfrontend/src/components/chatTab');
  await expect(options(page).first().locator('b')).toHaveText('Comp');
  await expect(input).toHaveAttribute('aria-activedescendant', await options(page).first().getAttribute('id') ?? '');
  await input.press('Enter');
  await expect(input).toHaveValue('Why does @frontend/src/components/chatTab/ChatComposerControls.tsx ');
  await expect(page.locator('.chat-input-highlight mark')).toHaveText('@frontend/src/components/chatTab/ChatComposerControls.tsx');
  await input.pressSequentially('wrap?');
  await input.press('Enter');
  await expect.poll(() => sent(page)).toEqual(['Why does @frontend/src/components/chatTab/ChatComposerControls.tsx wrap?']);
});

test('an empty @ lists changed files, then folders, then files', async ({ page }) => {
  const input = await open(page);
  await input.pressSequentially('@');
  await expect(options(page)).toHaveText(['ChatTabPanel.tsxfrontend/src/components/chatTabChanged', 'chatTab.cssfrontend/src/components/chatTabChanged', 'docs/', 'frontend/', 'main/', 'native/', 'README.md']);
  expect(await page.evaluate(() => window.qaQueries)).toEqual(['']);
});

test('keys: arrows wrap, Tab picks, hover chooses, a click picks, Escape closes only the menu', async ({ page }) => {
  const input = await open(page, 'working=1');
  await input.pressSequentially('@');
  await expect(options(page)).toHaveCount(7);
  await input.press('ArrowUp');
  await expect(options(page).last()).toHaveAttribute('aria-selected', 'true');
  await input.press('ArrowDown');
  await expect(options(page).first()).toHaveAttribute('aria-selected', 'true');
  await options(page).nth(2).hover();
  await expect(options(page).nth(2)).toHaveAttribute('aria-selected', 'true');
  await input.press('Escape');
  await expect(options(page)).toHaveCount(0);
  // Dismissed for this word until the caret leaves it.
  await input.pressSequentially('do');
  await expect(options(page)).toHaveCount(0);
  await input.fill('');
  await input.pressSequentially('@comp');
  await expect(options(page)).toHaveCount(7);
  await options(page).nth(4).click();
  await expect(input).toHaveValue('@native/src/features/composer/ ');
  await input.fill('');
  await input.pressSequentially('then $u');
  await input.press('Tab');
  await expect(input).toHaveValue('then $ui-options ');
});

test('a pick in the middle keeps one space and puts the caret after it', async ({ page }) => {
  const input = await open(page);
  await input.fill('fix  now');
  for (let step = 0; step < 4; step += 1) await input.press('ArrowLeft');
  await input.pressSequentially('$si');
  await input.press('Enter');
  await expect(input).toHaveValue('fix $simplify now');
  expect(await caret(page)).toBe(14);
  await input.pressSequentially('x');
  await expect(input).toHaveValue('fix $simplify xnow');
});

test('a mid-message /: Enter sends, Tab picks the top skill, an arrow then Enter picks', async ({ page }) => {
  const input = await open(page);
  await input.pressSequentially('Look in /si');
  await expect(page.getByText('Tab or ↓ picks · Enter sends')).toBeVisible();
  await options(page).first().hover();
  await expect(page.getByText('Tab or ↓ picks · Enter sends')).toBeVisible();
  await input.press('Enter');
  await expect.poll(() => sent(page)).toEqual(['Look in /si']);
  await input.pressSequentially('Fix it, then /si');
  await input.press('ArrowDown');
  await expect(page.getByText('Tab or ↓ picks · Enter sends')).toBeHidden();
  await input.press('Enter');
  await expect(input).toHaveValue('Fix it, then $simplify ');
  await input.fill('');
  await input.pressSequentially('go /si');
  await input.press('Tab');
  await expect(input).toHaveValue('go $simplify ');
});

test('paths, money, emails, code and pastes open nothing and send as typed', async ({ page }) => {
  const input = await open(page);
  const typed = ['look in /run', 'see https://runpane.com', 'and/or', '5 / 2', 'in /usr/local/bin', 'pays $5', 'or $10k', 'me@example.com', '`@a $b /si`'];
  for (const text of typed) {
    await input.pressSequentially(text);
    await expect(options(page)).toHaveCount(0);
    await input.press('Enter');
  }
  await expect.poll(() => sent(page)).toEqual(typed);
  await page.evaluate(() => {
    const box = document.querySelector('textarea')!;
    box.focus();
    document.execCommand('insertText', false, '');
  });
  await input.evaluate((box: HTMLTextAreaElement) => {
    box.setRangeText('@comp', 0, 0, 'end');
    box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: '@comp' }));
  });
  await expect(input).toHaveValue('@comp');
  await expect(options(page)).toHaveCount(0);
});

test('a first-word / lists commands and skills; a full command sends, a skill becomes $name', async ({ page }) => {
  const input = await open(page);
  await input.pressSequentially('/');
  await expect(options(page)).toHaveText([/^\/clear/, /^\/compact/, /^\/resume.*Pane$/, /^\/review/, /^\/rewrite-simply/, /^\/simplify/, /^\/ui-options/]);
  await input.pressSequentially('compact');
  await input.press('Enter');
  await expect.poll(() => sent(page)).toEqual(['/compact']);
  await input.pressSequentially('/simp');
  await input.press('Enter');
  await expect(input).toHaveValue('$simplify ');
});

test('searching, no match and a failed search say so; with no rows Enter sends', async ({ page }) => {
  let input = await open(page, 'files=hang');
  await input.pressSequentially('@');
  await expect(page.getByText('Searching files…')).toBeVisible();
  input = await open(page, 'files=fail');
  await input.pressSequentially('@');
  await expect(page.getByText("Pane couldn't list this folder's files.")).toBeVisible();
  input = await open(page);
  await input.pressSequentially('@zzz');
  await expect(page.getByText('No matching files or folders.')).toBeVisible();
  await input.press('Enter');
  await expect.poll(() => sent(page)).toEqual(['@zzz']);
  await input.pressSequentially('$zzz');
  await expect(page.getByText('No skills found.')).toBeVisible();
});

test('an agent that marks no skills, and an older host', async ({ page }, testInfo) => {
  let input = await open(page, 'mentions=files');
  await page.goto('/chat-tab-composer.html?mentions=files&skills=1&width=640');
  input = page.getByRole('textbox', { name: 'Message Claude' });
  // The composer is under 480px wide in the phone project, so the box says it the phone's shorter way.
  await expect(input).toHaveAttribute('placeholder', testInfo.project.name === 'phone' ? 'Ask anything, @ files, / commands' : 'Ask anything, @ for files, / for commands');
  await input.pressSequentially('$s');
  await expect(options(page)).toHaveCount(0);
  await page.goto('/chat-tab-composer.html?skills=1&width=640');
  await expect(input).toHaveAttribute('placeholder', 'Message Autopilot…');
  await input.pressSequentially('@comp');
  await expect(options(page)).toHaveCount(0);
  await input.fill('');
  await input.pressSequentially('/co');
  await expect(options(page).first()).toHaveText(/^\/compact/);
  await input.fill('');
  await input.pressSequentially('then /si');
  await expect(options(page)).toHaveCount(0);
});

test('sent references are marked; a file opens, and one that is gone says so', async ({ page }) => {
  await open(page, `sent=${encodeURIComponent('See @src/a.ts, @docs/ and $simplify. Not @gone/b.ts')}`);
  const bubble = page.locator('.chat-user').last();
  await expect(bubble.locator('.chat-mark')).toHaveText(['@src/a.ts', '@docs/', '$simplify', '@gone/b.ts']);
  await bubble.getByRole('button', { name: '@src/a.ts' }).click();
  await expect.poll(() => page.evaluate(() => window.qaCalls)).toEqual(['file:src/a.ts']);
  await bubble.getByRole('button', { name: '@gone/b.ts' }).click();
  await expect(page.getByText("That file is no longer in this chat's folder.")).toBeVisible();
});

test('the highlight stays on its text while it wraps and scrolls', async ({ page }) => {
  const input = await open(page, 'width=360');
  await input.pressSequentially('Why does @comp');
  await expect(options(page).first()).toBeVisible();
  await input.press('Enter');
  await input.pressSequentially('wrap under 360px?');
  // Enough lines to pass the input's cap (about 40% of the chat) so it scrolls.
  for (let line = 0; line < 24; line += 1) await input.press('Shift+Enter');
  const read = () => page.evaluate(() => {
    const box = document.querySelector('textarea')!;
    const layer = document.querySelector<HTMLElement>('.chat-input-highlight')!;
    return { width: [box.clientWidth, layer.clientWidth], height: [box.scrollHeight, layer.scrollHeight], top: [box.scrollTop, layer.scrollTop] };
  });
  await expect.poll(async () => Object.values(await read()).every(([box, layer]) => box === layer)).toBe(true);
  const sizes = await read();
  expect(sizes.top[0]).toBeGreaterThan(0);
});

if (shots) for (const theme of ['light', 'dark']) for (const width of [900, 360]) {
  test(`screenshots ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width: Math.max(width, 360), height: 720 });
    const shot = async (name: string, query: string, type?: string, after?: (input: ReturnType<Page['getByRole']>) => Promise<void>) => {
      const input = await open(page, `conversation=1&theme=${theme}&${query}`.replace('width=640', ''));
      await page.goto(`/chat-tab-composer.html?mentions=all&skills=1&conversation=1&width=${width}&theme=${theme}&${query}`);
      await expect(input).toBeVisible();
      if (type) { await input.pressSequentially(type); await page.waitForTimeout(400); }
      await after?.(input);
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${shots}/${name}-${theme}-${width}.png` });
    };
    await shot('files', '', 'Why does @comp');
    await shot('empty-at', '', '@');
    await shot('skills', '', 'Fix the wrap, then $s');
    await shot('slash-skill', '', 'Fix the wrap, then /si');
    await shot('slash-path', '', 'Look in /usr/local/bin');
    await shot('slash-first', '', '/');
    await shot('session', 'placeholder=session', '@');
    await shot('placeholder', '');
    await shot('placeholder-session', 'placeholder=session');
    await shot('picked', '', 'Why does @comp', async input => { await input.press('Enter'); await input.pressSequentially('wrap under 360px?'); });
    await shot('searching', 'files=hang', '@');
    await shot('no-match', '', '@zzz');
    await shot('error', 'files=fail', '@');
    await shot('sent', `sent=${encodeURIComponent('Why does @frontend/src/components/chatTab/ChatComposerControls.tsx wrap? Fix it, then $simplify.')}`);
  });
}
