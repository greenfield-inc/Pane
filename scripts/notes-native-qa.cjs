#!/usr/bin/env node
// Real Electron journey: no renderer mock, agent process, or provider credentials.
const { _electron: electron } = require('playwright');
const { expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const bundle = path.resolve(process.env.AGENT_FARM_ARTIFACT_BUNDLE || 'tmp/greenfield/pane-notes');
const evidence = path.join(bundle, 'evidence', 'native', process.platform);
fs.mkdirSync(evidence, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-notes-native-'));
const home = path.join(root, 'home');
const data = path.join(root, 'data');
const repo = path.join(root, 'project');
for (const directory of [home, data, repo]) fs.mkdirSync(directory, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|API_KEY|PASSWORD|ELECTRON_RUN_AS_NODE/i.test(key)));
Object.assign(env, {
  AGENT_FARM_ARTIFACT_BUNDLE: bundle, NODE_ENV: 'production', PANE_DIR: data,
  HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CURSOR_CONFIG_DIR: path.join(home, '.cursor'),
  APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
  GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
});
const authored = { 'AGENTS.md': '# Authored instructions\nKeep this file unchanged.\n', 'CLAUDE.md': '# Authored Claude instructions\nNative QA fixture.\n' };
function git(args, cwd = repo) { return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim(); }
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ analytics: { enabled: false }, onboardingCompleted: true, autoCheckUpdates: false }));
git(['init', '-b', 'main']);
fs.writeFileSync(path.join(repo, '.gitignore'), 'worktrees/\n');
for (const [file, content] of Object.entries(authored)) fs.writeFileSync(path.join(repo, file), content);
git(['add', '.']);
git(['-c', 'user.name=Pane QA', '-c', 'user.email=qa@example.invalid', 'commit', '-m', 'Create isolated fixture']);
let child, application, page;
let launchNumber = 0;
const results = { platform: process.platform, arch: process.arch, osRelease: os.release(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), root, steps: [] };
results.sourceHashes = Object.fromEntries(['frontend/src/components/panels/notes/NotesPanel.tsx', 'frontend/src/components/panels/notes/notesEditor.css', 'main/src/ipc/notes.ts', 'scripts/notes-native-qa.cjs'].map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
function pass(step) { results.steps.push(step); console.log('PASS', step); }
async function shot(name) { await page.screenshot({ path: path.join(evidence, name + '.png') }); }
async function launch() {
  const log = fs.createWriteStream(path.join(evidence, `electron-${++launchNumber}.log`));
  application = await electron.launch({ executablePath: require('electron'), args: ['.', '--user-data-dir=' + path.join(root, 'browser')], env, timeout: 60000 });
  child = application.process();
  child.stdout.pipe(log); child.stderr.pipe(log);
  const context = application.context();
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  // Startup update announcements can arrive during any journey in a dev build.
  const update = page.getByRole('dialog').filter({ hasText: 'Software Update' });
  await page.addLocatorHandler(update, async () => {
    await update.getByRole('button', { name: 'Close', exact: true }).click();
  });
  page.on('pageerror', error => fs.appendFileSync(path.join(evidence, 'renderer-errors.log'), error.stack + '\n'));
  await page.waitForFunction(() => Boolean(window.electronAPI));
}
async function stop() {
  if (application) {
    const running = application;
    application = undefined;
    await running.context().tracing.stop({ path: path.join(evidence, `trace-${launchNumber}.zip`) }).catch(() => {});
    // Exercise the real app quit lifecycle. child.kill() is an unconditional
    // termination on Windows and can resurrect unflushed DOMStorage drafts.
    let timer;
    try {
      await Promise.race([running.close(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Electron did not quit within 30 seconds')), 30000);
      })]);
    } finally {
      clearTimeout(timer);
      if (child && child.exitCode === null) child.kill();
    }
  }
}
async function list(pane, scope) { return page.evaluate(({ pane, scope }) => window.electronAPI.invoke('notes:list', pane, scope), { pane, scope }); }
async function selectScope(label) { await page.getByRole('button', { name: label, exact: true }).click(); }
async function choose(title) {
  await page.getByRole('button', { name: 'Choose note', exact: true }).click();
  await page.getByRole('menuitemradio', { name: title, exact: true }).click();
}
async function saved(pane, scope, title, text) {
  await expect.poll(async () => (await list(pane, scope)).some(note => note.title === title && note.blocks.some(block => block.type === 'text' && block.text === text)), { timeout: 15000 }).toBe(true);
}
async function addCanvasText(text, x, y) {
  const canvas = page.locator('.excalidraw__canvas.interactive');
  await expect(canvas).toBeVisible();
  const bounds = await canvas.boundingBox();
  assert(bounds, 'Drawing canvas has bounds');
  await canvas.click({ position: { x, y } });
  await page.keyboard.press('t');
  await page.mouse.click(bounds.x + x, bounds.y + y);
  await page.locator('textarea.excalidraw-wysiwyg').fill(text);
  await page.keyboard.press('Escape');
}
(async () => {
  await launch();
  const project = await page.evaluate(repo => window.electronAPI.projects.create({ name: 'Native Notes QA', path: repo }), repo);
  assert(project.success, JSON.stringify(project));
  if (await page.getByRole('button', { name: 'Skip', exact: true }).isVisible()) await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.evaluate(id => window.electronAPI.projects.activate(String(id)), project.data.id);
  const created = await page.evaluate(id => window.electronAPI.sessions.create({ prompt: 'Native Notes QA', worktreeTemplate: 'notes-qa', count: 1, projectId: id, toolType: 'none' }), project.data.id);
  assert(created.success, JSON.stringify(created));
  let session;
  await expect.poll(async () => {
    const all = await page.evaluate(() => window.electronAPI.sessions.getAll());
    session = all.data?.find(item => item.projectId === project.data.id && !item.isMainRepo);
    return Boolean(session?.worktreePath);
  }, { timeout: 30000 }).toBe(true);
  const pane = session.id;
  const featureScope = { kind: 'feature', id: pane };
  const projectScope = { kind: 'project', id: String(project.data.id) };
  const globalScope = { kind: 'global', id: 'user' };
  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  await page.getByRole('menuitem', { name: 'notes', exact: true }).click();
  await selectScope('Feature Notes');
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await page.getByRole('textbox', { name: 'Note title', exact: true }).fill('Native checkout');
  const text = page.getByRole('textbox', { name: 'Text block 1', exact: true });
  await text.fill('Review cart before payment.');
  await saved(pane, featureScope, 'Native checkout', 'Review cart before payment.');
  await selectScope('Project Notes');
  await selectScope('Feature Notes');
  await expect(text).toHaveValue('Review cart before payment.');
  await shot('01-autosave-scope-reopen');
  pass('Editing, autosave, scope switch and reopening');

  await page.getByRole('button', { name: 'Add block after block 1', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Drawing', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Drawing', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add block after block 1', exact: true })).toBeFocused();
  await text.click();
  await text.press('End');
  await text.pressSequentially(' /');
  await page.getByRole('menuitem', { name: 'Drawing', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit drawing', exact: true })).toBeVisible();
  await addCanvasText('Cart → Payment', 280, 230);
  await page.getByRole('textbox', { name: 'Drawing title', exact: true }).fill('Checkout sketch');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Edit drawing', exact: true })).toBeVisible();
  await shot('02-drawing-editor');
  await page.getByRole('button', { name: 'Save drawing', exact: true }).click();
  await page.getByRole('button', { name: 'Checkout sketch · Edit drawing', exact: true }).click();
  await addCanvasText('Verified edit', 520, 360);
  await page.getByRole('button', { name: 'Save drawing', exact: true }).click();
  await expect.poll(async () => (await list(pane, featureScope))[0]?.blocks.find(block => block.type === 'drawing')?.labels, { timeout: 15000 }).toContain('Verified edit');
  await shot('03-inline-drawing');
  pass('Plus/slash popover focus, drawing insertion and editing');

  const noteId = (await list(pane, featureScope))[0].id;
  for (const destination of ['Project Notes', 'Global Notes']) {
    await page.getByRole('button', { name: 'Note settings', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move to ' + destination, exact: true }).click();
  }
  await expect.poll(async () => (await list(pane, globalScope)).find(note => note.id === noteId)?.scope.kind).toBe('global');
  assert((await list(pane, featureScope)).some(note => note.id === noteId));
  assert((await list(pane, projectScope)).some(note => note.id === noteId));
  await selectScope('Global Notes');
  await choose('Native checkout');
  await shot('04-promoted-global');
  pass('Feature to project to global promotion retains references');

  for (const file of [path.join(env.CLAUDE_CONFIG_DIR, 'CLAUDE.md'), path.join(env.CODEX_HOME, 'AGENTS.md'), path.join(env.CURSOR_CONFIG_DIR, 'rules', 'pane-memories.mdc')]) {
    const content = fs.readFileSync(file, 'utf8');
    assert(content.includes('Cart → Payment') && content.includes('Verified edit'), file);
    const links = [...content.matchAll(/\]\(([^)]+\.(?:png|excalidraw))\)/g)].map(match => match[1]);
    assert(links.length >= 2, 'PNG and editable scene links: ' + file);
    for (const link of links) assert(fs.existsSync(path.resolve(path.dirname(file), decodeURIComponent(link))), link);
    fs.copyFileSync(file, path.join(evidence, path.basename(file)));
  }
  const hook = JSON.parse(fs.readFileSync(path.join(env.CURSOR_CONFIG_DIR, 'hooks.json'), 'utf8')).hooks.sessionStart[0].command;
  assert.equal(hook, process.platform === 'win32'
    ? 'powershell.exe -NoProfile -NonInteractive -Command "Get-Content -Raw -LiteralPath \'./pane-notes-context.json\'"'
    : "cat './pane-notes-context.json'");
  const hookOutput = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-Content -Raw -LiteralPath './pane-notes-context.json'"], { cwd: env.CURSOR_CONFIG_DIR, env, encoding: 'utf8' })
    : execFileSync('cat', ['./pane-notes-context.json'], { cwd: env.CURSOR_CONFIG_DIR, env, encoding: 'utf8' });
  assert(JSON.parse(hookOutput).additional_context.includes('Cart → Payment'));
  pass('Native memory paths, resolvable drawing exports, executable Cursor hook');

  const drafts = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pane-note-draft:')));
  fs.writeFileSync(path.join(evidence, 'drafts-before-quit.json'), JSON.stringify(drafts));
  assert.deepEqual(drafts, [], 'Successful saves clear renderer recovery drafts before quit');
  await stop();
  await launch();
  await page.getByRole('button', { name: 'notes-qa', exact: true }).click();
  await selectScope('Global Notes');
  await choose('Native checkout');
  await expect(page.getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue('Native checkout');
  await page.getByRole('button', { name: 'Checkout sketch · Edit drawing', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit drawing', exact: true })).toBeVisible();
  await shot('05-drawing-after-app-restart');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  pass('Full Electron restart preserves text and editable drawing');

  // Use the live IPC API to arrange an edit from a second Pane while this one
  // is archived; inspect the actual exported agent context after restore.
  const mainPane = await page.evaluate(id => window.electronAPI.sessions.getOrCreateMainRepoSession(id), project.data.id);
  assert(mainPane.success, JSON.stringify(mainPane));
  await page.evaluate(({ pane, scope }) => window.electronAPI.invoke('notes:mutate', pane, { action: 'create', scope, title: 'Feature retained on restore' }), { pane, scope: featureScope });
  await page.evaluate(({ pane, scope }) => window.electronAPI.invoke('notes:mutate', pane, { action: 'create', scope, title: 'Project before archive' }), { pane, scope: projectScope });
  const archived = await page.evaluate(id => window.electronAPI.sessions.delete(id), pane);
  assert(archived.success, JSON.stringify(archived));
  const projectNotes = await list(mainPane.data.id, projectScope);
  const projectNote = projectNotes.find(note => note.title === 'Project before archive');
  assert(projectNote);
  await page.evaluate(({ pane, note }) => window.electronAPI.invoke('notes:mutate', pane, { action: 'save', note: { ...note, title: 'Project updated while archived' } }), { pane: mainPane.data.id, note: projectNote });
  await expect.poll(async () => {
    const restored = await page.evaluate(id => window.electronAPI.sessions.restore(id), pane);
    if (!restored.success && !restored.error?.includes('archive cleanup')) throw new Error(JSON.stringify(restored));
    return restored.success;
  }, { timeout: 60000, intervals: [1000] }).toBe(true);
  const contextFile = path.join(data, 'notes', 'contexts', encodeURIComponent(pane) + '.md');
  await expect.poll(() => fs.readFileSync(contextFile, 'utf8')).toContain('Project updated while archived');
  const restoredContext = fs.readFileSync(contextFile, 'utf8');
  assert(restoredContext.includes('Feature retained on restore'));
  assert(!restoredContext.includes('Project before archive'));
  fs.copyFileSync(contextFile, path.join(evidence, 'restored-agent-context.md'));
  pass('Archive/restore exports current project context and retained feature notes');

  for (const directory of [repo, session.worktreePath]) {
    for (const [file, content] of Object.entries(authored)) assert.equal(fs.readFileSync(path.join(directory, file), 'utf8'), content);
    assert.equal(git(['status', '--porcelain'], directory), '', 'Authored repository stays clean');
  }
  pass('Authored AGENTS.md/CLAUDE.md preserved and both git statuses clean');
  results.success = true;
})().catch(async error => {
  results.success = false;
  results.error = error.stack;
  console.error(error);
  if (page) await shot('failure').catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  try { await stop(); }
  catch (error) { results.success = false; results.shutdownError = error.stack; process.exitCode = 1; }
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2));
});
