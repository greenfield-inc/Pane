import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A fully isolated Pane for end-to-end journeys (D-288): its own PANE_DIR, Electron profile,
 * HOME, CLAUDE_CONFIG_DIR and CODEX_HOME under one throwaway folder, OS integration off, and
 * nothing inherited from the terminal that runs the tests (PANE_*, RUNPANE_*, CLAUDE*,
 * AGENT_FARM*). It refuses to start when any of it resolves to the real ~/.pane.
 */
export interface IsolatedPane {
  root: string;
  paneDir: string;
  home: string;
  env: Record<string, string>;
}

const REAL_PANE = path.join(homedir(), '.pane');
const INHERITED = /^(PANE_|RUNPANE_|CLAUDE|AGENT_FARM|CODEX_|ELECTRON_RUN_AS_NODE$|ZDOTDIR$)/;

function assertNotRealPane(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    for (const entry of value.split(path.delimiter)) {
      if (entry === REAL_PANE || entry.startsWith(`${REAL_PANE}${path.sep}`)) {
        throw new Error(`Refusing to launch: ${key} resolves to the real ${REAL_PANE} (${entry}). Nothing was started.`);
      }
    }
  }
}

export function isolatedPane(prefix: string, extra: Record<string, string> = {}): IsolatedPane {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `${prefix}-`)));
  const paneDir = path.join(root, 'pane');
  const home = path.join(root, 'home');
  for (const dir of [paneDir, home, path.join(home, '.claude'), path.join(home, '.codex')]) mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || INHERITED.test(key)) continue;
    env[key] = value;
  }
  env.PATH = (env.PATH ?? '').split(path.delimiter).filter(entry => !entry.startsWith(REAL_PANE)).join(path.delimiter);
  Object.assign(env, {
    PANE_DIR: paneDir,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PANE_DISABLE_OS_INTEGRATION: '1',
    NODE_ENV: 'development',
    ...extra,
  });
  assertNotRealPane(env);
  return { root, paneDir, home, env };
}

export async function launchIsolated(pane: IsolatedPane, baseURL: string | undefined, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...pane.env, VITE_PORT: new URL(baseURL ?? 'http://localhost:4521').port, ...extra };
  assertNotRealPane(env);
  console.log(`[isolated Pane] data dir ${env.PANE_DIR}, socket under it, HOME ${env.HOME}`);
  const app = await electron.launch({
    args: [path.resolve('main/dist/main/src/index.js'), `--user-data-dir=${path.join(pane.root, 'electron')}`, '--use-mock-keychain', '--password-store=basic'],
    env,
  });
  const isMain = (candidate: Page): boolean => /^https?:|^file:/.test(candidate.url()) && !candidate.url().includes('notify.html');
  await expect.poll(() => app.windows().some(isMain), { timeout: 30_000 }).toBe(true);
  const page = app.windows().find(isMain)!;
  await page.waitForFunction(() => !!window.electronAPI?.orchestrationSessions, undefined, { timeout: 30_000, polling: 250 });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => !candidate.webContents.getURL().includes('notify.html'));
    window?.setContentSize(1500, 950);
  });
  return { app, page };
}

/** First-run dialogs (onboarding's agent picker, the welcome) can open a few seconds in. */
export async function dismissDialogs(page: Page): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    for (const name of ['No thanks', 'Get Started', 'Skip', 'Skip for now']) {
      const button = page.getByRole('button', { name, exact: true });
      if (await button.isVisible().catch(() => false)) await button.click().catch(() => undefined);
    }
    await page.waitForTimeout(250);
  }
}

/** The isolated Pane's bundled `runpane`, as an agent in the given tab would run it. */
export function runpane(pane: IsolatedPane, args: string[], from?: { paneId: string; panelId: string }): Promise<string> {
  const env = { ...pane.env, ...(from ? { PANE_SESSION_ID: from.paneId, PANE_PANEL_ID: from.panelId } : {}) };
  return new Promise((resolve, reject) => {
    execFile(path.join(pane.paneDir, 'bin', 'runpane'), args, { env, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`runpane ${args.join(' ')} failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}
