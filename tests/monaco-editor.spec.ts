import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { installElectronApiMock } from './electronApiMock';

const fixturePath = resolve(__dirname, 'fixtures/monaco-editor.tsx').replaceAll('\\', '/');
const files = {
  'alpha.ts': 'const first: string = 1;\nconst second = 2;\n',
  'beta.json': '{ "name": "beta" }',
  'style.css': 'body { color: red; }',
  'index.html': '<h1>Local editor</h1>',
  'notes.md': '# Notes\nOriginal text\n',
};

declare global {
  interface Window {
    __editorFiles: typeof files;
    __editorModelCount: number;
    __editorDiagnostics(): Promise<number[]>;
    __editorPauseWrites(): void;
    __editorResumeWrites(): void;
  }
}

async function openEditor(page: Page) {
  await installElectronApiMock(page);
  await page.addInitScript(initialFiles => {
    const contents = { ...initialFiles };
    let writesPaused = false;
    const pendingWrites: Array<() => void> = [];
    Object.defineProperty(window, '__editorPauseWrites', { value: () => { writesPaused = true; } });
    Object.defineProperty(window, '__editorResumeWrites', { value: () => {
      writesPaused = false;
      pendingWrites.splice(0).forEach(finish => finish());
    } });
    const invoke = window.electronAPI.invoke;
    // SAFETY: This adapter handles only the two file channels below and forwards
    // every other typed invoke to the standard Electron fixture.
    window.electronAPI.invoke = ((channel: string, ...args: unknown[]) => {
      if (channel === 'file:read' || channel === 'file:write') {
        // SAFETY: The real FileEditorView sends these file IPC requests, using
        // only the fixture paths exposed by its navigation controls.
        const request = args[0] as { filePath: keyof typeof contents; content?: string };
        if (channel === 'file:write') return new Promise(resolve => {
          const finish = () => {
            contents[request.filePath] = request.content ?? '';
            resolve({ success: true });
          };
          if (writesPaused) pendingWrites.push(finish);
          else finish();
        });
        return Promise.resolve({ success: true, content: contents[request.filePath] });
      }
      return invoke(channel, ...args);
    }) as typeof invoke;
    Object.defineProperty(window, '__editorFiles', { value: contents });
  }, files);
  await page.route('**/monaco-test', route => route.fulfill({
    contentType: 'text/html',
    body: `<div id="root"></div><script type="module" src="/@vite/client"></script><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/@fs/${fixturePath}"></script>`,
  }));
  await page.goto('/monaco-test');
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 20000 });
}

function savedFile(page: Page, path: keyof typeof files) {
  return page.evaluate(filePath => window.__editorFiles[filePath], path);
}

test('bundled editor and language workers function with external requests blocked', async ({ page }) => {
  test.setTimeout(120000);
  const externalRequests: string[] = [];
  const workers: string[] = [];
  page.on('worker', worker => workers.push(worker.url()));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      externalRequests.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  await openEditor(page);
  // A real worker response proves the language service booted, not just its URL.
  const diagnostics = await page.evaluate(() => window.__editorDiagnostics());
  expect(diagnostics).toContain(2322);
  expect(workers.some(url => url.includes('ts.worker'))).toBe(true);
  for (const [filePath, workerName] of [['beta.json', 'json.worker'], ['style.css', 'css.worker'], ['index.html', 'html.worker']]) {
    await page.getByRole('button', { name: `Open ${filePath}`, exact: true }).click();
    await expect.poll(() => workers.some(url => url.includes(workerName)), { timeout: 30000 }).toBe(true);
  }
  expect(externalRequests).toEqual([]);
});

test('retargeted files stay editable and restore their own cursor after remount', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEditor(page);
  const input = page.locator('.monaco-editor textarea');
  await input.focus();
  await page.keyboard.type('// restored cursor ');
  await input.press('ControlOrMeta+s');
  await expect.poll(() => savedFile(page, 'alpha.ts')).toBe('const first: string = 1;\n// restored cursor const second = 2;\n');

  await page.getByRole('button', { name: 'Open beta.json', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('beta');
  await input.focus();
  await input.press('ControlOrMeta+a');
  await page.keyboard.type('{ "edited": true }');
  await input.press('ControlOrMeta+s');
  await expect.poll(() => savedFile(page, 'beta.json')).toBe('{ "edited": true }');
  expect(await page.evaluate(() => window.__editorModelCount)).toBe(1);

  await page.getByRole('button', { name: 'Toggle editor', exact: true }).click();
  await expect(page.locator('.monaco-editor')).toHaveCount(0);
  expect(await page.evaluate(() => window.__editorModelCount)).toBe(0);
  await page.getByRole('button', { name: 'Toggle editor', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('edited');
  await input.focus();
  await input.press('ControlOrMeta+a');
  await page.keyboard.type('{ "remounted": true }');
  await input.press('ControlOrMeta+s');
  await expect.poll(() => savedFile(page, 'beta.json')).toBe('{ "remounted": true }');
  expect(errors).toEqual([]);
});

test('recovery waits for the user and permits one retry per file', async ({ page }) => {
  await openEditor(page);
  await page.clock.install();
  await page.getByRole('button', { name: 'Break editor', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry editor' })).toBeVisible();
  await page.clock.fastForward(1000);
  await expect(page.getByRole('button', { name: 'Retry editor' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry editor' }).click();
  await expect(page.getByText('Retry failed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry editor' })).toHaveCount(0);
});

test('unsaved text survives switching between Markdown preview and editing', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Open notes.md', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('Original text');
  await page.evaluate(() => window.__editorPauseWrites());
  const input = page.locator('.monaco-editor textarea');
  await input.focus();
  await input.press('ControlOrMeta+a');
  await page.keyboard.type('# Unsaved notes');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unsaved notes' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('Unsaved notes');
  expect(await savedFile(page, 'notes.md')).toBe(files['notes.md']);
  await page.evaluate(() => window.__editorResumeWrites());
  await input.focus();
  await input.press('ControlOrMeta+s');
  await expect.poll(() => savedFile(page, 'notes.md')).toBe('# Unsaved notes');
});
