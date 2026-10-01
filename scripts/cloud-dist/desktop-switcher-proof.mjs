#!/usr/bin/env node
// Drives the REAL Pane desktop (a packaged build, no electronApiMock) against a live cloud Session and
// records what a user sees: the host `runpane cloud sync` imports shows up in the sidebar host switcher,
// picking it connects and lists the remote repos, a terminal panel runs on the cloud machine, and what
// the switcher says while the host is asleep. Writes screenshots, a Playwright trace and results.json.
//
// Linux, under a display (xvfb-run -a -s "-screen 0 1440x900x24" node ...), from the repository root
// after `pnpm install`. The machine must reach the Session over the tailnet.
//
//   PANE_BIN=/opt/Pane/pane          packaged desktop binary (for example from a cloud-dist .deb)
//   DESK_DIR=/tmp/desk               isolated desktop data dir (becomes PANE_DIR); never ~/.pane
//   OUT=/tmp/out                     evidence directory
//   HOST_LABEL=w2dp-desk             the cloud host's label in the switcher
//   EXPECT=awake|asleep              what the Session is doing right now
//   RUNPANE=runpane                  CLI used for `cloud sync` (with RUNPANE_CLOUD_DIR set) when SYNC=1
//   SYNC=1                           import with `runpane cloud sync` while the app runs
//   SETTINGS_WRITE=1                 after the import, change a setting in the app and check the host survives
//   REPO=Hello-World PANE_NAME=gui   awake: open (or create) this pane and run a command in its terminal
//   AWAIT_WAKE=1                     asleep: then wait for the host's /health (run `runpane cloud wake` meanwhile)
//                                    and pick it again
import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = process.env;
const required = (name) => {
  if (!env[name]) throw new Error(`desktop-switcher-proof: set ${name}`);
  return env[name];
};
const deskDir = path.resolve(required('DESK_DIR'));
if (deskDir === path.join(os.homedir(), '.pane')) throw new Error('desktop-switcher-proof: DESK_DIR must not be ~/.pane');
const out = path.resolve(required('OUT'));
const hostLabel = required('HOST_LABEL');
const expectState = env.EXPECT === 'asleep' ? 'asleep' : 'awake';
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(deskDir, { recursive: true });

const started = Date.now();
const checks = [];
const log = (...parts) => {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(out, 'steps.log'), `${line}\n`);
};
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  log(ok ? 'PASS' : 'FAIL', name, detail ?? '');
};
const savedProfiles = () => {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(deskDir, 'config.json'), 'utf8'));
    return (config.remoteDaemon?.client?.profiles ?? []).map((profile) => profile.label ?? profile.id);
  } catch {
    return [];
  }
};

const app = await electron.launch({
  executablePath: required('PANE_BIN'),
  args: ['--no-sandbox'],
  env: { ...env, PANE_DIR: deskDir },
  timeout: 90_000,
});
const context = app.context();
await context.tracing.start({ screenshots: true, snapshots: true, title: `desktop-switcher-proof ${expectState}` });
const page = await app.firstWindow();
let shotIndex = 0;
const shot = async (name) => {
  const file = path.join(out, `${String(++shotIndex).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  fs.writeFileSync(file.replace(/\.png$/, '.aria.yml'), await page.locator('body').ariaSnapshot().catch(() => ''));
};

// First-run dialogs a new user meets: the updater (fork rc builds see upstream's release as newer),
// onboarding and the welcome card. Dismiss them the way a user would.
async function dismissFirstRun() {
  for (let round = 0; round < 5; round++) {
    await page.waitForTimeout(700);
    const update = page.getByRole('dialog', { name: 'Software Update' });
    if (await update.isVisible().catch(() => false)) {
      log('first run: Software Update -> Close');
      await update.getByRole('button', { name: 'Close', exact: true }).click();
      continue;
    }
    const skip = page.getByRole('button', { name: 'Skip', exact: true });
    if (await skip.isVisible().catch(() => false)) {
      log('first run: Get Started -> Skip');
      await skip.click();
      continue;
    }
    const welcome = page.getByRole('dialog', { name: 'Welcome to Pane' });
    if (await welcome.isVisible().catch(() => false)) {
      log('first run: Welcome -> Close modal');
      await welcome.getByRole('button', { name: 'Close modal' }).click();
      continue;
    }
    return;
  }
}

const switcherChip = page.getByRole('button', { name: /Switch host$/ });

try {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(5000);
  await dismissFirstRun();
  await shot('launched');

  if (env.SYNC === '1') {
    const syncStarted = Date.now();
    const output = execFileSync(env.RUNPANE ?? 'runpane', ['cloud', 'sync', '--json'], {
      env: { ...env, RUNPANE_CLOUD_DESKTOP_DIR: deskDir },
      encoding: 'utf8',
    });
    log('cloud sync:', output.replace(/\s+/g, ' '));
    const shown = await switcherChip.first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check('import-shows-without-restart', shown, shown ? `switcher chip after ${Date.now() - syncStarted} ms` : 'no switcher chip 15 s after cloud sync');
    await shot('after-sync');

    if (env.SETTINGS_WRITE === '1') {
      // Any in-app save: the Keep Awake switch on Home writes config.json.
      await page.getByRole('button', { name: 'Home', exact: true }).click();
      await page.getByRole('switch').first().click();
      await page.waitForTimeout(2000);
      const profiles = savedProfiles();
      check('import-survives-in-app-save', profiles.includes(hostLabel), `saved hosts on disk after the save: ${JSON.stringify(profiles)}`);
    }
  }

  await dismissFirstRun();
  await switcherChip.first().waitFor({ timeout: 30_000 });
  await switcherChip.first().click();
  await page.waitForTimeout(500);
  await shot('switcher-open');
  const hostItem = page.getByRole('menuitemradio', { name: new RegExp(hostLabel) });
  check('switcher-lists-cloud-host', await hostItem.isVisible(), hostLabel);
  const pickedAt = Date.now();
  await hostItem.click();

  if (expectState === 'awake') {
    const chip = page.getByRole('button', { name: `Agents run on ${hostLabel}. Switch host` });
    await chip.waitFor({ timeout: 30_000 });
    const repoButton = env.REPO ? page.getByRole('button', { name: `New pane in ${env.REPO}` }) : null;
    const listed = repoButton ? await repoButton.waitFor({ timeout: 30_000 }).then(() => true, () => false) : true;
    check('connects-and-lists-remote', listed, `remote repo ${env.REPO ?? '(not checked)'} listed ${Date.now() - pickedAt} ms after picking the host`);
    await shot('connected');

    if (env.REPO && env.PANE_NAME) {
      const existing = page.getByRole('button', { name: env.PANE_NAME, exact: true });
      if (await existing.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
        await existing.click();
      } else {
        await repoButton.click();
        const dialog = page.getByRole('dialog', { name: `New Pane in ${env.REPO}` });
        await dialog.getByRole('textbox', { name: 'Enter a name for your pane' }).fill(env.PANE_NAME);
        await dialog.getByRole('button', { name: /^Create/ }).click();
      }
      await page.getByRole('button', { name: /^Terminal Ctrl\+Alt\+1/ }).click({ timeout: 30_000 });
      const terminal = page.locator('.xterm').last();
      await terminal.waitFor({ timeout: 30_000 });
      await page.waitForTimeout(2000);
      await terminal.click();
      const marker = `W2DP_${Date.now()}`;
      await page.keyboard.type(`echo ${marker}:$(hostname):$(pwd)\n`, { delay: 15 });
      const echoed = await page.waitForFunction(
        (needle) => [...document.querySelectorAll('.xterm-rows')].some((rows) => (rows.textContent ?? '').split(needle).length > 2),
        marker,
        { timeout: 20_000 },
      ).then(() => true, () => false);
      const text = (await page.locator('.xterm-rows').last().textContent()) ?? '';
      const line = text.slice(text.lastIndexOf(marker)).slice(0, 200);
      fs.writeFileSync(path.join(out, 'terminal-output.txt'), `${line}\n`);
      check('terminal-runs-on-cloud-host', echoed && !line.includes(os.hostname()), `${line} (this machine is ${os.hostname()})`);
      await shot('terminal');
    }
  } else {
    // Give the connect attempt time to fail the way it does for a user, sampling what the UI says.
    const timeline = [];
    const waitMs = Number(env.ASLEEP_WAIT_MS ?? 20_000);
    while (Date.now() - pickedAt < waitMs) {
      const labels = await page.evaluate(() => [...new Set([
        ...[...document.querySelectorAll('[aria-label]')]
          .map((element) => element.getAttribute('aria-label') ?? '')
          .filter((label) => /switch host|remote runtime|cloud host|connect/i.test(label)),
        ...[...document.querySelectorAll('[role="dialog"] h2')].map((heading) => `dialog: ${heading.textContent ?? ''}`),
      ])]);
      const sample = `${String(Math.round((Date.now() - pickedAt) / 1000)).padStart(3)} s  ${labels.join(' | ')}`;
      if (timeline.at(-1)?.slice(6) !== sample.slice(6)) timeline.push(sample);
      await page.waitForTimeout(2000);
    }
    fs.writeFileSync(path.join(out, 'asleep-timeline.txt'), `${timeline.join('\n')}\n`);
    log('asleep timeline:', timeline.join(' || '));
    await shot('asleep-sidebar');
    // A failed pick of a sleeping cloud host explains itself in the error dialog.
    const dialog = page.getByRole('dialog', { name: 'Cloud host asleep or unreachable' });
    const dialogText = await dialog.isVisible().catch(() => false) ? (await dialog.textContent()) ?? '' : '';
    if (dialogText) {
      fs.writeFileSync(path.join(out, 'asleep-dialog.txt'), `${dialogText}\n`);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
    const chipLabel = await switcherChip.first().getAttribute('aria-label');
    await switcherChip.first().click();
    await page.waitForTimeout(500);
    await shot('asleep-switcher-open');
    const menuText = (await page.getByRole('menu').first().textContent().catch(() => '')) ?? '';
    const bodyText = (await page.locator('body').textContent()) ?? '';
    const hint = [menuText, bodyText, dialogText].some((text) => /runpane cloud wake/.test(text));
    fs.writeFileSync(path.join(out, 'asleep-switcher.txt'), `chip: ${chipLabel}\nmenu: ${menuText}\n`);
    check('asleep-names-wake-command', hint, `chip "${chipLabel}"; switcher "${menuText.replace(/\s+/g, ' ').slice(0, 300)}"${dialogText ? `; dialog "${dialogText.slice(0, 300)}"` : ''}`);

    if (env.AWAIT_WAKE === '1') {
      // The user runs `runpane cloud wake` elsewhere, then picks the host again.
      await page.keyboard.press('Escape');
      const profile = JSON.parse(fs.readFileSync(path.join(deskDir, 'config.json'), 'utf8'))
        .remoteDaemon.client.profiles.find((entry) => entry.label === hostLabel);
      log('waiting for the host to wake:', profile.baseUrl);
      const waitStarted = Date.now();
      let awake = false;
      while (!awake && Date.now() - waitStarted < Number(env.AWAIT_WAKE_MS ?? 600_000)) {
        awake = await fetch(`${profile.baseUrl}/health`, { signal: AbortSignal.timeout(3000) }).then((response) => response.ok, () => false);
        if (!awake) await page.waitForTimeout(3000);
      }
      log('host /health answered:', awake, `after ${Math.round((Date.now() - waitStarted) / 1000)} s`);
      await switcherChip.first().click();
      const repickedAt = Date.now();
      await page.getByRole('menuitemradio', { name: new RegExp(hostLabel) }).click();
      const back = await page.getByRole('button', { name: `Agents run on ${hostLabel}. Switch host` })
        .waitFor({ timeout: 30_000 }).then(() => true, () => false);
      const listed = back && env.REPO
        ? await page.getByRole('button', { name: `New pane in ${env.REPO}` }).waitFor({ timeout: 30_000 }).then(() => true, () => false)
        : back;
      check('reconnects-after-wake', awake && listed, `picked again ${Math.round((repickedAt - waitStarted) / 1000)} s into the wait; connected and listed in ${Date.now() - repickedAt} ms`);
      await shot('after-wake');
    }
  }
} catch (error) {
  check('run-completed', false, error instanceof Error ? error.message.split('\n')[0] : String(error));
  await shot('error').catch(() => undefined);
} finally {
  await context.tracing.stop({ path: path.join(out, `trace-${expectState}.zip`) });
  await app.close().catch(() => undefined);
  const result = { expect: expectState, ok: checks.every((entry) => entry.ok), seconds: Math.round((Date.now() - started) / 1000), checks };
  fs.writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  log(result.ok ? 'RESULT PASS' : 'RESULT FAIL');
  process.exitCode = result.ok ? 0 : 1;
}
