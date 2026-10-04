import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { CloudSandboxAction, CloudSandboxProgressStep, CloudSandboxView } from '../shared/types/cloudSandboxes';
import type { RemotePaneConnectionProfile } from '../shared/types/remoteDaemon';

type CloudMockControls = {
  reportCloudStep(name: string, step: CloudSandboxProgressStep): void;
  finishCloudCreate(name: string, failure?: string): void;
  failNextCloudAction(action: CloudSandboxAction, message: string): void;
  setCloudSandbox(id: string, updates: Partial<CloudSandboxView>): void;
  getCloudCalls(): Array<{ action: CloudSandboxAction; id: string }>;
  getCloudCredentialUpdateKeys(): string[][];
  getCloudStartupScriptSaves(): string[];
  getCloudLocalStartScriptSaves(): Array<{ shell: string; script: string }>;
  setCloudStartupLog(id: string, log: string): void;
};

const ALL_CREDENTIALS = { boat: true, tailscale: true, claude: true, github: true };
const HOUR_MS = 60 * 60 * 1000;

function cloudProfile(name: string): RemotePaneConnectionProfile {
  return {
    id: `cloud-${name}`,
    label: name,
    baseUrl: `https://rp-${name}.tail1234.ts.net`,
    token: 'synthetic-cloud-token',
    transport: 'http+sse',
    cloud: { provider: 'boat', sandboxId: `sbx-${name}`, sessionId: name, nodeId: `node-${name}`, hostname: `rp-${name}`, version: 1 },
    hostKind: { label: 'cloud sandbox', icon: 'cloud' },
  };
}

function cloudSandbox(name: string, overrides: Partial<CloudSandboxView> = {}): CloudSandboxView {
  return {
    id: `rp-${name}`,
    label: name,
    hostname: `rp-${name}`,
    profileId: `cloud-${name}`,
    state: 'running',
    size: 'default',
    ...overrides,
  };
}

async function cloudMock<Result>(page: Page, run: (controls: CloudMockControls) => Result): Promise<Result> {
  return page.evaluate(`(${run.toString()})(window.__paneTestElectronMock)`);
}

async function openRemoteAccess(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cloud sandboxes (experimental)' })).toBeVisible();
}

test('cloud credentials are saved once and only shown as set or not set', async ({ page }, testInfo) => {
  await installElectronApiMock(page, { cloudSandboxes: { credentials: { boat: false, tailscale: false, claude: false, github: false }, sandboxes: [] } });
  await openRemoteAccess(page);

  const status = page.getByRole('definition');
  await expect(status).toHaveText(['Not set', 'Account default', 'Not set', 'Not set', 'Not set']);
  await expect(page.getByRole('button', { name: 'Add Cloud Sandbox' })).toBeDisabled();

  await page.getByLabel('boat API key').fill('synthetic-boat-key-value');
  await page.getByLabel('boat wallet').fill('test');
  await page.getByLabel('Tailscale OAuth client ID').fill('synthetic-ts-client-id');
  await expect(page.getByRole('button', { name: 'Save Credentials' })).toBeDisabled();
  await expect(page.getByText('Enter both the client ID and secret')).toBeVisible();
  await page.getByLabel('Tailscale OAuth client secret').fill('synthetic-ts-client-secret');
  await page.getByLabel('Claude token').fill('synthetic-claude-token');
  await page.getByRole('button', { name: 'Save Credentials' }).click();

  await expect(status).toHaveText(['Set', 'test', 'Set', 'Set', 'Not set']);
  await expect(page.getByLabel('boat API key')).toHaveCount(0);
  expect(await cloudMock(page, (mock) => mock.getCloudCredentialUpdateKeys())).toEqual([['boatApiKey', 'boatOrg', 'claudeToken', 'tailscale']]);
  const html = await page.content();
  for (const value of ['synthetic-boat-key-value', 'synthetic-ts-client-secret', 'synthetic-claude-token', 'synthetic-ts-client-id']) {
    expect(html).not.toContain(value);
  }
  await page.getByRole('heading', { name: 'Cloud sandboxes (experimental)' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('cloud-credentials-saved.png') });

  // Changing one credential sends only that one.
  await page.getByRole('button', { name: 'Change Credentials' }).click();
  await expect(page.getByLabel('boat API key')).toHaveValue('');
  await page.getByLabel('Claude token').fill('synthetic-claude-token-2');
  await page.getByRole('button', { name: 'Save Credentials' }).click();
  expect((await cloudMock(page, (mock) => mock.getCloudCredentialUpdateKeys())).at(-1)).toEqual(['claudeToken']);
});

test('adding a cloud sandbox shows live progress, a failure with Retry, then the running host', async ({ page }, testInfo) => {
  await installElectronApiMock(page, { cloudSandboxes: { credentials: ALL_CREDENTIALS, sandboxes: [] } });
  await openRemoteAccess(page);

  await page.getByLabel('Name', { exact: true }).fill('Bad Name');
  await expect(page.getByText('Use lowercase letters, digits and dashes')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Cloud Sandbox' })).toBeDisabled();
  await page.getByLabel('Name', { exact: true }).fill('alpha');
  await page.getByRole('radio', { name: 'Small' }).click();
  await page.getByRole('button', { name: 'Add Cloud Sandbox' }).click();

  const row = page.getByRole('listitem', { name: 'Cloud sandbox alpha' });
  await expect(row.getByText('Creating', { exact: true })).toBeVisible();
  await cloudMock(page, (mock) => {
    mock.reportCloudStep('alpha', { step: 'sandbox', state: 'done', message: 'Created boat sandbox rp-alpha' });
    mock.reportCloudStep('alpha', { step: 'tailnet', state: 'done', message: 'Joined your tailnet as rp-alpha' });
    mock.reportCloudStep('alpha', { step: 'install', state: 'start', message: 'Installing Pane' });
  });
  const progress = row.getByRole('status', { name: 'Progress for alpha' });
  await expect(progress.getByRole('listitem')).toHaveText(['Created boat sandbox rp-alpha', 'Joined your tailnet as rp-alpha', 'Installing Pane']);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('cloud-create-progress.png') });

  await cloudMock(page, (mock) => mock.finishCloudCreate('alpha', 'install: the Pane package did not install'));
  await expect(row.getByText('Error', { exact: true })).toBeVisible();
  await expect(row.getByRole('alert')).toHaveText('install: the Pane package did not install');
  await row.getByRole('alert').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('cloud-create-failed.png') });

  await row.getByRole('button', { name: 'Retry alpha' }).click();
  await expect(row.getByText('Creating', { exact: true })).toBeVisible();
  await expect(row.getByRole('alert')).toHaveCount(0);
  await cloudMock(page, (mock) => mock.finishCloudCreate('alpha'));

  await expect(row.getByText('Running', { exact: true })).toBeVisible();
  await expect(row.getByText('rp-alpha · small · running for 1m')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Stop alpha' })).toBeVisible();
  expect((await cloudMock(page, (mock) => mock.getCloudCalls())).map((call) => call.action)).toEqual(['create', 'create']);

  // The new host is in the switcher like any other saved host.
  await page.getByRole('button', { name: 'Close modal' }).click();
  await page.getByRole('button', { name: 'Agents run on This computer. Switch host' }).click();
  await expect(page.getByRole('menuitemradio', { name: /alpha/ })).toContainText('https://rp-alpha.tail1234.ts.net');
});

test('cloud rows stop, start, update Pane and remove after confirmation', async ({ page }, testInfo) => {
  const startedAt = new Date(Date.now() - 5 * HOUR_MS - 60_000).toISOString();
  await installElectronApiMock(page, {
    cloudSandboxes: {
      credentials: ALL_CREDENTIALS,
      sandboxes: [
        cloudSandbox('alpha', { startedAt, daemonVersion: '2.4.140', updateAvailable: true }),
        cloudSandbox('beta', { state: 'stopped', size: 'large' }),
      ],
      profiles: [cloudProfile('alpha'), cloudProfile('beta')],
    },
  });
  await openRemoteAccess(page);

  const alpha = page.getByRole('listitem', { name: 'Cloud sandbox alpha' });
  const beta = page.getByRole('listitem', { name: 'Cloud sandbox beta' });
  await expect(alpha.getByText('rp-alpha · default · running for 5h · Pane 2.4.140 (differs from this app)')).toBeVisible();
  await expect(alpha.getByRole('button')).toHaveText(['Update Pane', 'Open terminal', 'Stop', 'Startup script', 'Remove']);
  await expect(beta.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(beta.getByRole('button')).toHaveText(['Start', 'Startup script', 'Remove']);
  await alpha.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('cloud-rows.png') });

  await alpha.getByRole('button', { name: 'Update Pane alpha' }).click();
  await expect(alpha.getByText('Updating', { exact: true })).toBeVisible();
  await expect(alpha.getByText('Running', { exact: true })).toBeVisible();
  await expect(alpha.getByRole('button')).toHaveText(['Open terminal', 'Stop', 'Startup script', 'Remove']);

  await alpha.getByRole('button', { name: 'Stop alpha' }).click();
  await expect(alpha.getByText('Stopping', { exact: true })).toBeVisible();
  await expect(alpha.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(alpha.getByText(/running for/)).toHaveCount(0);

  await cloudMock(page, (mock) => mock.failNextCloudAction('start', 'boat.dev did not resume the sandbox in time'));
  await alpha.getByRole('button', { name: 'Start alpha' }).click();
  await expect(alpha.getByRole('alert')).toHaveText('boat.dev did not resume the sandbox in time');
  await alpha.getByRole('button', { name: 'Dismiss alpha' }).click();
  await alpha.getByRole('button', { name: 'Start alpha' }).click();
  await expect(alpha.getByText('Running', { exact: true })).toBeVisible();

  await beta.getByRole('button', { name: 'Remove beta' }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove beta?' });
  await expect(confirm).toContainText('destroys the sandbox and its tailnet device');
  await page.screenshot({ path: testInfo.outputPath('cloud-remove-confirm.png') });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(beta).toBeVisible();
  await beta.getByRole('button', { name: 'Remove beta' }).click();
  await page.getByRole('dialog', { name: 'Remove beta?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(beta).toHaveCount(0);

  expect((await cloudMock(page, (mock) => mock.getCloudCalls())).map((call) => `${call.action} ${call.id}`)).toEqual([
    'update rp-alpha',
    'stop rp-alpha',
    'start rp-alpha',
    'start rp-alpha',
    'remove rp-beta',
  ]);
  const savedProfiles = await page.evaluate(() => window.electronAPI.remoteDaemon.getConfig().then((response) => response.data?.client.profiles.map((profile) => profile.id)));
  expect(savedProfiles).toEqual(['cloud-alpha']);
});

test('the host switcher starts a stopped sandbox, then connects to it', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    cloudSandboxes: {
      credentials: ALL_CREDENTIALS,
      sandboxes: [cloudSandbox('beta', { state: 'stopped' })],
      profiles: [cloudProfile('beta')],
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agents run on This computer. Switch host' }).click();

  const beta = page.getByRole('menuitemradio', { name: /beta/ });
  await expect(beta).toContainText('Stopped · Select to start');
  await page.screenshot({ path: testInfo.outputPath('switcher-stopped-sandbox.png') });
  await beta.click();

  await expect(page.getByRole('button', { name: 'Agents run on beta. Switch host' })).toBeVisible();
  expect(await cloudMock(page, (mock) => mock.getCloudCalls())).toEqual([{ action: 'start', id: 'rp-beta' }]);
  await page.getByRole('button', { name: 'Agents run on beta. Switch host' }).click();
  await expect(page.getByRole('menuitemradio', { name: /beta/ })).toContainText('Connected · https://rp-beta.tail1234.ts.net');
});

test('a sandbox boat is still saving shows Stopping in the row and the switcher, then Stopped with Start', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    cloudSandboxes: {
      credentials: ALL_CREDENTIALS,
      sandboxes: [cloudSandbox('beta')],
      profiles: [cloudProfile('beta')],
    },
  });
  await openRemoteAccess(page);
  const row = page.getByRole('listitem', { name: 'Cloud sandbox beta' });
  await expect(row.getByText('Running', { exact: true })).toBeVisible();

  // What main pushes after a Stop that outlived its wait while boat still archives.
  await cloudMock(page, (mock) => mock.setCloudSandbox('rp-beta', { state: 'stopping', pending: 'stopping', progress: 'Saving the sandbox…' }));
  await expect(row.getByText('Stopping', { exact: true })).toBeVisible();
  await expect(row.getByRole('status')).toHaveText('Saving the sandbox…');
  await expect(row.getByRole('button', { name: /^(Stop|Start) beta$/ })).toHaveCount(0);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('cloud-row-stopping.png') });

  await cloudMock(page, (mock) => mock.setCloudSandbox('rp-beta', { state: 'stopping', pending: undefined, progress: undefined }));
  await expect(row.getByText('Stopping', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: /^(Stop|Start) beta$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close modal' }).click();
  await page.getByRole('button', { name: 'Agents run on This computer. Switch host' }).click();
  const switcherRow = page.getByRole('menuitemradio', { name: /beta/ });
  await expect(switcherRow).toContainText('Stopping cloud sandbox…');
  await expect(switcherRow).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('switcher-stopping.png') });

  await cloudMock(page, (mock) => mock.setCloudSandbox('rp-beta', { state: 'stopped' }));
  await expect(switcherRow).toContainText('Stopped · Select to start');
  await expect(switcherRow).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await expect(row.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Start beta' })).toBeVisible();
});

test('without the cloud library the section explains itself and remote hosts are unchanged', async ({ page }) => {
  await installElectronApiMock(page);
  await openRemoteAccess(page);

  await expect(page.getByText('Cloud sandboxes are not available in this build of Pane.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Cloud Sandbox' })).toHaveCount(0);
  await expect(page.getByText('Using local runtime')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set Up Host' })).toBeVisible();
});

test('a running sandbox row opens the same terminal as the host switcher', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    cloudSandboxes: {
      credentials: ALL_CREDENTIALS,
      sandboxes: [
        cloudSandbox('alpha'),
        cloudSandbox('beta', { state: 'stopped' }),
        cloudSandbox('gamma', { state: 'starting' }),
        cloudSandbox('delta', { pending: 'stopping' }),
      ],
      profiles: [cloudProfile('alpha'), cloudProfile('beta'), cloudProfile('gamma'), cloudProfile('delta')],
    },
  });
  await openRemoteAccess(page);

  const alpha = page.getByRole('listitem', { name: 'Cloud sandbox alpha' });
  await expect(alpha.getByRole('button', { name: 'Open terminal on alpha' })).toHaveText('Open terminal');
  for (const name of ['beta', 'gamma', 'delta']) {
    await expect(page.getByRole('listitem', { name: `Cloud sandbox ${name}` }).getByRole('button', { name: /Open terminal/ })).toHaveCount(0);
  }
  await alpha.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('cloud-row-open-terminal.png') });

  // This window is on this computer: the row connects to alpha first.
  await alpha.getByRole('button', { name: 'Open terminal on alpha' }).click();
  const tab = page.getByRole('tab', { name: 'alpha · Terminal' });
  await expect(tab).toBeVisible();
  await expect(tab.locator('..').locator('svg.lucide-cloud')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Agents run on alpha. Switch host' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('cloud-row-terminal-tab.png') });

  await page.getByRole('button', { name: 'Agents run on alpha. Switch host' }).click();
  await page.getByRole('menuitem', { name: 'Open terminal on alpha' }).click();
  await expect(tab).toBeVisible();
  const opened = await page.evaluate(() => {
    // SAFETY: installElectronApiMock defines __paneTestElectronMock with getInvokeCalls.
    const mock = (window as typeof window & { __paneTestElectronMock: {
      getInvokeCalls: (channel: string) => Array<{ args: unknown[] }>;
    } }).__paneTestElectronMock;
    return mock.getInvokeCalls('host-terminal:open').length;
  });
  expect(opened).toBe(2);
});

test('the startup script is edited once for every sandbox, with no sandbox yet, and saved on this computer', async ({ page }, testInfo) => {
  await installElectronApiMock(page, { cloudSandboxes: { credentials: ALL_CREDENTIALS, sandboxes: [] } });
  await openRemoteAccess(page);

  await expect(page.getByText("Don't put secrets here; it's stored unencrypted.")).toBeVisible();
  const editor = page.getByRole('textbox', { name: 'Startup script' });
  const save = page.getByRole('button', { name: 'Save Startup Script' });
  await expect(save).toBeDisabled();
  await editor.fill('echo "E2E_MARKER $(date -Is)" >> ~/e2e-startup-marker.log\n');
  await save.click();

  await expect(page.locator('[data-setting-id="remote-cloud-startup-script"]').getByText('Saved', { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  expect(await cloudMock(page, (mock) => mock.getCloudStartupScriptSaves())).toEqual(['echo "E2E_MARKER $(date -Is)" >> ~/e2e-startup-marker.log\n']);
  await page.screenshot({ path: testInfo.outputPath('cloud-startup-script-editor.png'), fullPage: true });
});

test('a sandbox row shows a running script, then a failure chip whose View log shows the log', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    cloudSandboxes: { credentials: ALL_CREDENTIALS, sandboxes: [cloudSandbox('beta')], profiles: [cloudProfile('beta')] },
  });
  await openRemoteAccess(page);
  const row = page.getByRole('listitem', { name: 'Cloud sandbox beta' });

  await page.getByRole('textbox', { name: 'Startup script' }).fill('exit 1\n');
  await page.getByRole('button', { name: 'Save Startup Script' }).click();
  await expect(row.getByRole('status').filter({ hasText: 'Running your startup script…' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Stop beta' })).toBeVisible();

  await cloudMock(page, (mock) => {
    mock.setCloudStartupLog('rp-beta', '== startup script run ==\nboom\n== exit 1 after 0 s ==\n');
    mock.setCloudSandbox('rp-beta', { startupScript: { state: 'failed', exitCode: 1 } });
  });
  await expect(row.getByRole('alert')).toContainText('⚠ Startup script failed (exit 1)');
  await row.getByRole('button', { name: 'View log for beta' }).click();
  const dialog = page.getByRole('dialog', { name: 'Startup log: beta' });
  await expect(dialog).toContainText('boom');
  await page.screenshot({ path: testInfo.outputPath('cloud-startup-script-log.png'), fullPage: true });
  await page.keyboard.press('Escape');

  await cloudMock(page, (mock) => mock.setCloudSandbox('rp-beta', { startupScript: { state: 'failed', exitCode: 124, timedOut: true } }));
  await expect(row.getByRole('alert')).toContainText('⚠ Startup script failed (timed out after 10 min)');

  await row.getByRole('button', { name: 'Startup script beta' }).click();
  await expect(page.getByRole('textbox', { name: 'Startup script' })).toBeFocused();
});

test('the first cloud sandbox brings up the host switcher, and removing the last one hides it', async ({ page }) => {
  await installElectronApiMock(page, { cloudSandboxes: { credentials: ALL_CREDENTIALS, sandboxes: [] } });
  await openRemoteAccess(page);
  const switcher = page.getByRole('button', { name: 'Agents run on This computer. Switch host' });

  await page.getByLabel('Name', { exact: true }).fill('alpha');
  await page.getByRole('button', { name: 'Add Cloud Sandbox' }).click();
  // A create takes minutes: the user closes Settings and keeps working.
  await page.getByRole('button', { name: 'Close modal' }).click();
  await expect(switcher).toHaveCount(0);

  await cloudMock(page, (mock) => mock.finishCloudCreate('alpha'));
  await expect(switcher).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await page.getByRole('button', { name: 'Remove alpha' }).click();
  await page.getByRole('dialog', { name: 'Remove alpha?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('listitem', { name: 'Cloud sandbox alpha' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close modal' }).click();
  await expect(switcher).toHaveCount(0);
});

test('the GitHub token is saved masked, shown only as set, and the row shows how each sandbox signed in', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    cloudSandboxes: {
      credentials: { ...ALL_CREDENTIALS, github: false },
      sandboxes: [
        cloudSandbox('alpha', { github: { state: 'signed-in', user: 'octo-cat' } }),
        cloudSandbox('beta', { github: { state: 'invalid' } }),
        cloudSandbox('gamma', { github: { state: 'error', message: "gh isn't installed on the sandbox." } }),
        cloudSandbox('delta'),
      ],
      profiles: ['alpha', 'beta', 'gamma', 'delta'].map(cloudProfile),
    },
  });
  await openRemoteAccess(page);

  const field = page.getByRole('textbox', { name: 'GitHub token' });
  await expect(field).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('Saved GitHub token')).toContainText('Not set');
  await expect(page.getByText('A fine-grained personal access token with Contents and Pull requests set to Read and write')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create a fine-grained token' })).toBeVisible();
  await field.fill('FAKE-GH-TOKEN-ui-SECRET');
  await page.getByRole('button', { name: 'Save GitHub Token' }).click();
  await expect(field).toHaveValue('');
  expect((await cloudMock(page, (mock) => mock.getCloudCredentialUpdateKeys())).at(-1)).toEqual(['githubToken']);
  await expect(page.getByLabel('Saved GitHub token').getByRole('definition')).toHaveText('Set');
  await expect(page.getByText('FAKE-GH-TOKEN-ui-SECRET')).toHaveCount(0);

  await expect(page.getByRole('listitem', { name: 'Cloud sandbox alpha' })).toContainText('GitHub: signed in as octo-cat');
  await expect(page.getByRole('listitem', { name: 'Cloud sandbox beta' }).getByRole('alert')).toContainText('⚠ GitHub token invalid');
  await expect(page.getByRole('listitem', { name: 'Cloud sandbox gamma' }).getByRole('alert'))
    .toContainText("⚠ GitHub sign-in didn't finish: gh isn't installed on the sandbox.");
  await expect(page.getByRole('listitem', { name: 'Cloud sandbox delta' })).not.toContainText('GitHub');
  await page.screenshot({ path: testInfo.outputPath('cloud-github-token.png'), fullPage: true });
});

test('asking for the host\'s GitHub settings focuses the GitHub token field, even when sandboxes load slowly', async ({ page }) => {
  await installElectronApiMock(page, { cloudSandboxes: { credentials: ALL_CREDENTIALS, sandboxes: [], loadDelayMs: 1500 } });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });

  // What the clone notice's "Open Settings" does on a cloud sandbox.
  await page.evaluate(() => window.dispatchEvent(new Event('pane:open-host-github-settings')));

  // The token box itself, ready to paste into, not just its row.
  const field = page.locator('#settings-remote-cloud-github-token').getByLabel('GitHub token', { exact: true });
  await expect(field).toBeFocused({ timeout: 5_000 });
  await expect(field).toBeInViewport();
});

test('a sandbox being created shows once, with its startup script step visible, even when it is already listed', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    cloudSandboxes: {
      credentials: ALL_CREDENTIALS,
      sandboxes: [
        {
          id: 'create:alpha', label: 'alpha', state: 'creating', size: 'default',
          steps: [{ step: 'saved-host', state: 'done', message: 'Saving alpha as a remote host...' }, { step: 'startup', state: 'start', message: 'Running your startup script…' }],
        },
        cloudSandbox('alpha'),
      ],
      profiles: [cloudProfile('alpha')],
    },
  });
  await openRemoteAccess(page);

  const entries = page.getByRole('listitem', { name: 'Cloud sandbox alpha' });
  await expect(entries).toHaveCount(1);
  await expect(entries.getByText('Creating', { exact: true })).toBeVisible();
  const step = entries.getByText('Running your startup script…');
  await step.scrollIntoViewIfNeeded();
  await expect(step).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('cloud-create-once.png'), fullPage: true });
});

test('adding a sandbox warns about missing setup, and each link focuses its field', async ({ page }, testInfo) => {
  await installElectronApiMock(page, { cloudSandboxes: { credentials: { ...ALL_CREDENTIALS, github: false }, sandboxes: [] } });
  await openRemoteAccess(page);

  const warning = page.getByRole('status', { name: 'Setup a new sandbox would miss' });
  await expect(warning).toContainText('No GitHub token is set.');
  // Non-blocking: the sandbox can still be added.
  await page.getByLabel('Name', { exact: true }).fill('alpha');
  await expect(page.getByRole('button', { name: 'Add Cloud Sandbox' })).toBeEnabled();
  await warning.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('setup-warning.png') });

  await warning.getByRole('button', { name: 'Set a GitHub token' }).click();
  await expect(page.locator('#settings-remote-cloud-github-token').getByLabel('GitHub token', { exact: true })).toBeFocused();
});

test('the setup warning leaves out a GitHub token that is already set', async ({ page }) => {
  await installElectronApiMock(page, { cloudSandboxes: { credentials: { ...ALL_CREDENTIALS, github: true }, sandboxes: [] } });
  await openRemoteAccess(page);

  const warning = page.getByRole('status', { name: 'Setup a new sandbox would miss' });
  await expect(warning.getByRole('button', { name: 'Set a local start script' })).toBeVisible();
  await expect(warning.getByRole('button', { name: 'Set a GitHub token' })).toHaveCount(0);
});

test('the local start script is saved on this computer only, and its failures show on the row of the sandbox that ran it', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    cloudSandboxes: {
      credentials: { ...ALL_CREDENTIALS, github: true },
      sandboxes: [
        cloudSandbox('alpha', { localStart: { state: 'failed', exitCode: 2 } }),
        cloudSandbox('beta', { localStart: { state: 'timeout', seconds: 60 } }),
        cloudSandbox('gamma', { localStart: { state: 'ok', reserved: ['PATH'] } }),
        cloudSandbox('delta'),
      ],
      profiles: ['alpha', 'beta', 'gamma', 'delta'].map(cloudProfile),
    },
  });
  await openRemoteAccess(page);

  // E8 (cs-host-terminal's warning) reads the real saved flag: shown until a local start script is saved.
  const warning = page.getByRole('status', { name: 'Setup a new sandbox would miss' });
  await expect(warning).toContainText('No local start script is set.');
  await expect(page.getByText("Fetch secrets here, don't paste them: the script is stored unencrypted.")).toBeVisible();
  const editor = page.getByRole('textbox', { name: 'Local start script' });
  await editor.fill('echo "DOPPLER_TOKEN=$(doppler configure get token --plain)"');
  const before = await cloudMock(page, (mock) => mock.getCloudCalls());
  await page.getByRole('button', { name: 'Save Local Start Script' }).click();
  await expect(page.getByRole('button', { name: 'Save Local Start Script' })).toBeDisabled();
  expect((await cloudMock(page, (mock) => mock.getCloudLocalStartScriptSaves())).at(-1)).toEqual({ shell: 'sh', script: 'echo "DOPPLER_TOKEN=$(doppler configure get token --plain)"' });
  expect(await cloudMock(page, (mock) => mock.getCloudCalls())).toEqual(before);
  await expect(warning).toHaveCount(0);

  await expect(page.getByRole('listitem', { name: 'Cloud sandbox alpha' }).getByRole('alert')).toContainText('⚠ Local start script failed (exit 2)');
  await expect(page.getByRole('listitem', { name: 'Cloud sandbox beta' }).getByRole('alert')).toContainText('⚠ Local start script timed out after 60 s');
  await expect(page.getByRole('listitem', { name: 'Cloud sandbox gamma' })).toContainText('Local start script: skipped reserved names PATH');
  await expect(page.getByRole('listitem', { name: 'Cloud sandbox delta' })).not.toContainText('Local start script');
  await page.screenshot({ path: testInfo.outputPath('cloud-local-start-script.png'), fullPage: true });
});

test('the local start script link focuses that field, and the warning goes away once both are set', async ({ page }, testInfo) => {
  await installElectronApiMock(page, { cloudSandboxes: { credentials: { ...ALL_CREDENTIALS, github: true }, sandboxes: [] } });
  await openRemoteAccess(page);

  const warning = page.getByRole('status', { name: 'Setup a new sandbox would miss' });
  await warning.getByRole('button', { name: 'Set a local start script' }).click();
  await expect(page.getByRole('textbox', { name: 'Local start script' })).toBeFocused();

  await page.getByRole('textbox', { name: 'Local start script' }).fill('echo E2E_VAR=1');
  await page.getByRole('button', { name: 'Save Local Start Script' }).click();
  await expect(warning).toHaveCount(0);
  await page.getByRole('button', { name: 'Add Cloud Sandbox' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('setup-warning-gone.png') });
});

test('on Windows the local start script link lands in the script box, past the shell choice', async ({ page }) => {
  // The renderer tells Windows apart by navigator.platform.
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }));
  await installElectronApiMock(page, { platform: 'win32', cloudSandboxes: { credentials: { ...ALL_CREDENTIALS, github: true }, sandboxes: [] } });
  await openRemoteAccess(page);

  await expect(page.locator('#settings-remote-cloud-local-start-script').getByRole('radiogroup', { name: 'Shell' })).toBeAttached();
  await page.getByRole('status', { name: 'Setup a new sandbox would miss' }).getByRole('button', { name: 'Set a local start script' }).click();
  await expect(page.getByRole('textbox', { name: 'Local start script' })).toBeFocused();
});
