import { expect, test } from '@playwright/test';
import path from 'node:path';

test('opens tab actions with right click and keyboard without a visible menu button', async ({ page }) => {
  const fixture = path.resolve('tests/fixtures/agent-chat-context.tsx');
  await page.route('**/agent-chat-context.html', route => route.fulfill({ contentType: 'text/html', body: `<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto('/agent-chat-context.html');
  const tab = page.getByRole('tab', { name: 'Claude fixture' });
  await expect(tab).toBeVisible();
  await expect(page.getByRole('button', { name: 'View Claude fixture as' })).toHaveCount(0);
  await expect(page.getByLabel('Conversation options')).toHaveCount(0);
  await tab.click({ button: 'right' });
  await expect(page.getByRole('menuitemradio', { name: 'View as Chat', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(tab).toBeFocused();
  await tab.press('Shift+F10');
  await page.getByRole('menuitemradio', { name: 'View as Chat', exact: true }).click();
  await expect(page.getByLabel('Host switch result')).toHaveText('chat:1');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Other actions' }).press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: 'Last selected' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: 'First enabled' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('menuitemradio', { name: 'Last selected' })).toBeFocused();
  await expect(page.getByRole('menuitemradio', { name: 'Middle disabled' })).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Actions with footer' }).press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Menu action' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Footer action' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('menuitem', { name: 'Menu action' })).toBeFocused();
});
for (const olderPage of [false,true]) test(`restores actual reading position after asynchronous reload; olderPage=${olderPage}`,async({page},testInfo)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const fixture = path.resolve('tests/fixtures/agent-chat-lifecycle.tsx');
 await page.route('**/agent-chat-lifecycle.html', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
 await page.goto('/agent-chat-lifecycle.html');
 const viewport=page.getByRole('region',{name:'Conversation messages'});
 await expect(page.getByText('Historical reply 599',{exact:true})).toBeInViewport();
 await page.getByRole('textbox',{name:'Message agent'}).fill('Retained QA draft');
 if(olderPage){await page.getByRole('button',{name:/^Earlier messages/}).click();await expect(page.getByText('Historical reply 399',{exact:true})).toBeAttached();}
 await viewport.hover();await page.mouse.wheel(0,-700);
 await expect.poll(()=>viewport.evaluate(e=>e.scrollHeight-e.clientHeight-e.scrollTop)).toBeGreaterThan(400);
 const capture=()=>viewport.evaluate(e=>{const rect=e.getBoundingClientRect();const ps=[...e.querySelectorAll('p')];const anchor=ps.find(p=>p.getBoundingClientRect().top>=rect.top&&p.getBoundingClientRect().bottom<=rect.bottom);return {top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight,anchor:anchor?.textContent,y:anchor?anchor.getBoundingClientRect().top-rect.top:null}});
 const before=await capture();expect(before.top).toBeGreaterThan(500);expect(before.anchor).toBeTruthy();
 await page.screenshot({path:testInfo.outputPath('before-detach.png')});
 await page.getByRole('button',{name:'Detach viewer',exact:true}).click();await expect(viewport).not.toBeAttached();
 const detached=await page.evaluate(()=>{const s=window.qaViewer.snapshot();return {top:window.qaViewer.scrollTop,transcriptReleased:!s.view?.transcript,windowEnd:s.windowEnd,draft:s.draft}});
 expect(detached.transcriptReleased).toBe(true);
 await page.getByRole('button',{name:'Restore viewer',exact:true}).click();await expect(viewport).toBeAttached();
 await expect.poll(()=>page.evaluate(()=>window.qaReadCount())).toBe(2);
 await expect(viewport.locator('p').filter({hasText:/Historical reply/})).toHaveCount(0);
 await page.screenshot({path:testInfo.outputPath('reload-held.png')});
 await page.getByRole('button',{name:'Release transcript',exact:true}).click();
 await expect(page.getByText(olderPage?'Historical reply 399':'Historical reply 599',{exact:true})).toBeAttached();
 // Allow asynchronous runtime synchronization and browser scroll effects to settle.
 await page.waitForTimeout(500);
 const after=await capture();
 await testInfo.attach('actual-dom-state',{body:JSON.stringify({before,detached,after,errors},null,2),contentType:'application/json'});
 await page.screenshot({path:testInfo.outputPath('after-reload.png')});
 await expect(page.getByRole('textbox',{name:'Message agent'})).toHaveValue('Retained QA draft');
 expect(errors).toEqual([]);expect(after.anchor).toBe(before.anchor);expect(Math.abs(after.top-before.top)).toBeLessThanOrEqual(2);expect(Math.abs((after.y??0)-(before.y??0))).toBeLessThanOrEqual(2);
});


test('keeps resource and future content visible after transcript replay', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = path.resolve('tests/fixtures/agent-chat-lifecycle.tsx');
  await page.route('**/agent-chat-content.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto('/agent-chat-content.html?content');
  for (const replay of [false, true]) {
    if (replay) {
      await page.getByRole('button', { name: 'Detach viewer', exact: true }).click();
      await page.getByRole('button', { name: 'Restore viewer', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.qaReadCount())).toBe(2);
      await page.getByRole('button', { name: 'Release transcript', exact: true }).click();
    }
    for (const [label, value] of [['Resource: Report', 'file:///workspace/report.md'], ['Resource content', 'Embedded resource text'], ['Content: future-content', 'Future provider value']]) {
      const details = page.locator('details').filter({ has: page.locator('summary', { hasText: label }) });
      await expect(details.locator('summary')).toBeVisible();
      await details.locator('summary').click();
      await expect(details.locator('[aria-label="Content details"]')).toBeVisible();
      await expect(details.locator('[aria-label="Content details"]')).toContainText(value);
    }
    expect(await page.evaluate(() => window.qaViewer.snapshot().view?.transcript?.messages.map(message => message.id))).toEqual(['resource-link', 'embedded-resource', 'future-content']);
    await page.screenshot({ path: testInfo.outputPath(`content-replay-${replay}.png`) });
  }
  expect(errors).toEqual([]);
});

test('combines configuration on narrow screens and preserves host option values', async ({ page }, testInfo) => {
  const fixture = path.resolve('tests/fixtures/agent-chat-lifecycle.tsx');
  await page.route('**/agent-chat-configuration.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto('/agent-chat-configuration.html?configuration');
  if (testInfo.project.name === 'desktop') {
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Conversation configuration', exact: true })).toBeHidden();
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole('textbox', { name: 'Message agent' }).fill('Retained configuration draft');
  const trigger = page.getByRole('button', { name: 'Conversation configuration', exact: true });
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText('Sonnet 5.5 · High');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeHidden();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
  const menu = page.getByRole('dialog', { name: 'Conversation configuration' });
  const model = menu.getByRole('combobox', { name: 'Model', exact: true });
  const effort = menu.getByRole('combobox', { name: 'Effort', exact: true });
  await expect(model).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(model).toBeFocused();
  // Native select type-ahead commits in headless macOS Chromium; arrow keys
  // alone open its platform picker without committing a value.
  await page.keyboard.press('o');
  await page.keyboard.press('Enter');
  await expect(model).toHaveValue('opus');
  await expect(trigger).toContainText('Opus 5.5 · High');
  await expect.poll(() => page.evaluate(() => window.qaConfigurationCalls)).toEqual([{ id: 'model', value: 'opus' }]);
  await page.keyboard.press('Tab');
  await expect(effort).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(model).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(effort).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(effort).toBeFocused();
  await page.keyboard.press('l');
  await page.keyboard.press('Enter');
  await expect(effort).toHaveValue('low');
  await expect(trigger).toContainText('Opus 5.5 · Low');
  await expect.poll(() => page.evaluate(() => window.qaConfigurationCalls)).toEqual([{ id: 'model', value: 'opus' }, { id: 'effort', value: 'low' }]);
  await page.screenshot({ path: testInfo.outputPath('combined-configuration-open.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(model).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('textbox', { name: 'Message agent' })).toBeFocused();
  await trigger.click();
  await page.keyboard.press('Tab');
  await expect(effort).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('combined-configuration-closed.png') });
});

for (const embedded of [false, true]) test(`identifies a legacy conversation through a keyboard-accessible contextual form; embedded=${embedded}`, async ({ page }, testInfo) => {
  const fixture = path.resolve('tests/fixtures/agent-chat-context.tsx');
  await page.route('**/agent-chat-context.html?legacy*', route => route.fulfill({ contentType: 'text/html', body: `<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto(`/agent-chat-context.html?legacy=${embedded ? 'embedded' : 'shared'}`);
  const tab = page.getByRole('tab', { name: 'Claude fixture' });
  await tab.press('Shift+F10');
  const dialog = page.getByRole('dialog', { name: 'Identify this Codex conversation' });
  await expect(dialog).toBeVisible();
  const id = dialog.getByLabel('Codex Session ID');
  const socket = dialog.getByLabel('Codex server socket');
  await expect(id).toBeFocused();
  await id.fill('01a169da-b81b-7552-bccf-e7c790a37ece');
  if (!embedded) {
    await page.keyboard.press('Tab'); await expect(socket).toBeFocused();
    await socket.fill('/owned/codex-control.sock');
  } else await expect(socket).toHaveCount(0);
  await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Connect conversation' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('identify-conversation.png') });
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Host switch result')).toHaveText(`01a169da-b81b-7552-bccf-e7c790a37ece:${embedded ? '' : '/owned/codex-control.sock'}`);
  await expect(page.getByRole('menuitemradio', { name: 'View as Chat', exact: true })).toBeEnabled();
});
