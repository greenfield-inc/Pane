// Drives a sandboxed Electron build of the working tree for visual checks.
//
// Launches main/dist against the running Vite dev server (port 4521) with an
// isolated --pane-dir/--user-data-dir under $S, runs the comma-separated STEPS
// and screenshots each into $S. Nothing touches the developer's real profile.
//
//   S=/tmp/pane-drive STEPS="open,focus,type:ls,resize:1000x700,sidebar,menu,inspector:Files" \
//     node scripts/pane-drive.mjs
//
// Steps: open · focus · type:<cmd> · resize:<w>x<h> · sidebar · menu ·
//        inspector:<Details|Files|Changes> · dump · dump2 · dump3
// Requires `pnpm exec playwright install chromium` once and `pnpm dev` running.
import { _electron as electron } from 'playwright';
import path from 'node:path';
const S = process.env.S, REPO = '/Users/tbrownio/repos/dcouple/pane';
const shot = async (page, n) => { await page.screenshot({ path: path.join(S, n) }); console.log('shot', n); };
const app = await electron.launch({
  args: [path.join(REPO, 'main/dist/main/src/index.js'), `--pane-dir=${S}/pane-dir`, `--user-data-dir=${S}/udd`],
  cwd: REPO, env: { ...process.env, NODE_ENV: 'development', VITE_PORT: '4521' },
});
await app.evaluate(({ dialog }, repo) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] }); }, REPO);
const page = await app.firstWindow();
const consoleLog = []; page.on('console', (m) => { if (['error','warning'].includes(m.type()) && !m.text().includes('CommandExecutor')) consoleLog.push(m.type() + ': ' + m.text().slice(0, 300)); }); page.on('pageerror', (e) => consoleLog.push('pageerror: ' + String(e).slice(0, 300)));
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(2500);
const gs = page.getByRole('button', { name: 'Get Started' }); try { await gs.waitFor({ timeout: 6000 }); await gs.click(); await page.waitForTimeout(800); } catch { /* the welcome screen is optional */ }
for (let i = 0; i < 5; i++) { const b = page.getByRole('dialog').getByRole('button', { name: /^(Get Started|No thanks|Skip|Don't show this again|Close)$/ }).first(); try { await b.waitFor({ timeout: 2500 }); await b.click(); await page.waitForTimeout(800); } catch { break; } }
await shot(page, 'e1-home.png');
const steps = (process.env.STEPS || '').split(',').filter(Boolean);
try {
  for (const s of steps) {
    if (s === 'open') { const side = page.locator('.pane-sidebar-shell'); const proj = side.getByText('pane', { exact: true }).first(); try { await proj.waitFor({ timeout: 8000 }); } catch { /* the project may not be listed yet */ }
      if (await proj.count()) { const main = side.getByText('pane (Main)').first(); if (!(await main.count())) { await proj.dispatchEvent('click'); await page.waitForTimeout(1500); } if (await main.count()) await main.dispatchEvent('click'); await page.waitForTimeout(3000); await shot(page, 'e2-opened.png'); continue; }
      await page.getByText('Open Project', { exact: true }).first().click(); await page.waitForTimeout(800); await page.getByText('Add Repository').first().click(); await page.waitForTimeout(800); await shot(page,'e2a-dialog.png');
      const pathIn = page.getByPlaceholder('/path/to/your/repository'); await pathIn.fill(REPO); await page.waitForTimeout(500);
      const nameIn = page.locator('input[type="text"]').first(); if (!(await nameIn.inputValue())) await nameIn.fill('pane');
      await page.getByRole('button', { name: 'Create' }).click(); await page.waitForTimeout(5000); await shot(page, 'e2-opened.png'); }
    if (s === 'term') { await page.getByText('Add Tool').first().click(); await page.waitForTimeout(500); await shot(page, 'e3-menu.png'); await page.getByRole('menuitem', { name: /^Terminal/ }).or(page.getByText('Terminal', { exact: true })).first().click(); await page.waitForTimeout(2500); await shot(page, 'e4-term.png'); }
    if (s === 'menu') { await page.getByRole('button', { name: 'Add tool' }).click(); await page.waitForTimeout(600); await shot(page, 'e9-menu.png'); await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
    if (s.startsWith('inspector:')) { const t = s.slice(10); await page.getByRole('tablist', { name: 'Inspector' }).getByRole('tab', { name: t }).click(); await page.waitForTimeout(2500); await shot(page, `e10-inspector-${t}.png`); }
    if (s === 'dump') { console.log('URL', page.url()); console.log('TABS', await page.evaluate(() => Array.from(document.querySelectorAll('[role=tab]')).map(t => (t.getAttribute('aria-label') || t.textContent || '').trim()).join(' | '))); console.log('INSPECTOR', await page.evaluate(() => !!document.querySelector('[role=tablist][aria-label=Inspector]'))); console.log('SRC', await page.evaluate(async () => (await (await fetch('/src/components/SessionView.tsx')).text()).includes('isInspectorPanel'))); }
    if (s === 'dump2') { console.log('RES', await page.evaluate(() => performance.getEntriesByType('resource').map(r => r.name).filter(n => /SessionView|DetailPanel|InspectorTabs|main\.tsx|index-|assets\//.test(n)).slice(0,12).join('\n'))); console.log('SCRIPTS', await page.evaluate(() => Array.from(document.scripts).map(s => s.src).join(' '))); console.log('DETAIL', await page.evaluate(() => !!document.querySelector('.pane-detail-panel-vertical'))); }
    if (s === 'dump3') { await page.waitForTimeout(3000); console.log('LS', await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(k => /detail|inspector|layout/.test(k)).map(k => [k, localStorage.getItem(k)]))))); console.log('TABS3', await page.evaluate(() => Array.from(document.querySelectorAll('[role=tab]')).map(t => t.outerHTML.slice(0, 160)).join('\n'))); console.log('DW', await page.evaluate(() => document.querySelector(".pane-detail-panel-vertical")?.style.width)); }
    if (s.startsWith('file:')) { const n = s.slice(5); await page.locator('.pane-explorer-tree').getByText(n, { exact: true }).first().click(); await page.waitForTimeout(2000); await shot(page, `e12-file-${n.replace(/[^a-z0-9]/gi,'_')}.png`); }
    if (s.startsWith('dfile:')) { const n = s.slice(6); await page.locator('.pane-explorer-tree').getByText(n, { exact: true }).first().dblclick(); await page.waitForTimeout(2000); await shot(page, `e13-dfile-${n.replace(/[^a-z0-9]/gi,'_')}.png`); }
    if (s.startsWith('dtab:')) { const n = s.slice(5); await page.getByRole('tab', { name: n, exact: true }).first().dblclick(); await page.waitForTimeout(1500); await shot(page, `e14-dtab-${n.replace(/[^a-z0-9]/gi,'_')}.png`); }
    if (s.startsWith('key:')) { await page.keyboard.press(s.slice(4)); await page.waitForTimeout(800); }
    if (s === 'editor') { await page.locator('.monaco-editor').first().click({ position: { x: 200, y: 100 } }); await page.waitForTimeout(300); }
    if (s.startsWith('addrepo:')) { await page.getByRole('button', { name: 'Add repository', exact: true }).click(); await page.waitForTimeout(600); const pathIn = page.getByPlaceholder('/path/to/your/repository'); await pathIn.fill(s.slice(8)); await page.waitForTimeout(500); const nameIn2 = page.locator('input[type="text"]').first(); if (!(await nameIn2.inputValue())) await nameIn2.fill(s.slice(8).split('/').pop()); await page.getByRole('button', { name: 'Create' }).click(); await page.waitForTimeout(4000); await shot(page, 'e15-addrepo.png'); }
    if (s.startsWith('cfile:')) { const n = s.slice(6); await page.getByRole('button', { name: `Open diff for ${n}`, exact: true }).click(); await page.waitForTimeout(2500); await shot(page, `e16-cfile-${n.replace(/[^a-z0-9]/gi,'_')}.png`); }
    if (s.startsWith('cdfile:')) { const n = s.slice(7); await page.getByRole('button', { name: `Open diff for ${n}`, exact: true }).dblclick(); await page.waitForTimeout(2000); }
    if (s === 'addterm') { await page.getByRole('button', { name: 'Add tool' }).first().click(); await page.waitForTimeout(400); await page.getByRole('menuitem', { name: /^Terminal/ }).first().click(); await page.waitForTimeout(2000); }
    if (s.startsWith('shot:')) { await shot(page, `e17-${s.slice(5)}.png`); }
    if (s === 'state') { console.log('STATE', await page.evaluate(() => JSON.stringify({ sidebar: document.querySelector('.pane-sidebar-slot')?.style.width, inspector: !!document.querySelector('[role=tablist][aria-label=Inspector]'), title: document.querySelector('[data-testid=window-title-bar-label]')?.textContent, activeTab: Array.from(document.querySelectorAll('[role=tab][aria-selected=true]')).map(t => t.getAttribute('aria-label')).join('|'), dialogs: Array.from(document.querySelectorAll('[role=dialog]')).map(d => d.getAttribute('aria-label') || d.querySelector('h1,h2,h3')?.textContent || 'dialog').join('|'), menu: !!document.querySelector('[role=menu]'), palette: !!document.querySelector('[placeholder*="command" i],[aria-label*="Command Palette" i]'), dockOpen: (document.querySelector('.pane-terminal-shell-body')?.getBoundingClientRect().height ?? 0) > 20, active: (document.activeElement?.closest('.pane-sidebar-shell') ? 'sidebar:' : '') + (document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName) }))); }
    if (s === 'logs') { console.log('LOGS\n' + consoleLog.splice(0).join('\n')); }
    if (s === 'tabs') { console.log('TABS', await page.evaluate(() => Array.from(document.querySelectorAll('[role=tab]')).map(t => { const span = t.parentElement?.querySelector('span.truncate'); const italic = span ? getComputedStyle(span).fontStyle : '?'; return `${(t.getAttribute('aria-label') || '').trim()}[${italic}${t.getAttribute('aria-selected')==='true'?',active':''}]`; }).join(' | '))); }
    if (s === 'sidemenu') { await page.getByRole('button', { name: 'Sidebar menu' }).click(); await page.waitForTimeout(500); await shot(page, 'e11-sidemenu.png'); await page.keyboard.press('Escape'); }
    if (s === 'focus') { await page.locator('.xterm').first().click({ position: { x: 300, y: 200 } }); await page.waitForTimeout(300); }
    if (s.startsWith('type:')) { await page.keyboard.type(s.slice(5)); await page.keyboard.press('Enter'); await page.waitForTimeout(2500); await shot(page, `e5-typed-${s.slice(5).replace(/[^a-z0-9]/gi,'_').slice(0,20)}.png`); }
    if (s.startsWith('resize:')) { const [w,h] = s.slice(7).split('x').map(Number); await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(1500); await shot(page, `e6-resize-${w}x${h}.png`); }
    if (s === 'sidebar') { await page.keyboard.press('Meta+b'); await page.waitForTimeout(1500); await shot(page, `e7-sidebar-${Math.random().toString(36).slice(2,6)}.png`); await page.keyboard.press('Meta+b'); await page.waitForTimeout(1500); await shot(page, `e8-sidebar-back-${Math.random().toString(36).slice(2,6)}.png`); }
  }
} catch (e) { console.error('STEP FAILED', e.message); await shot(page, 'err.png'); }
await app.close();
