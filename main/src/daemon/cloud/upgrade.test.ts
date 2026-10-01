import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildUpgradeScript,
  downloadToFile,
  parseCloudUpgradeRequest,
  resolveOwnSystemdUnit,
  resolveSystemdUnitFromCgroup,
  runCloudUpgrade,
  type CloudUpgradeDependencies,
} from './upgrade';

const PACKAGE_BYTES = Buffer.from('fake deb');
const PACKAGE_SHA = createHash('sha256').update(PACKAGE_BYTES).digest('hex');
const tempDirs: string[] = [];

function dependencies(overrides: Partial<CloudUpgradeDependencies> = {}): CloudUpgradeDependencies {
  const downloadDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-cloud-upgrade-'));
  tempDirs.push(downloadDirectory);
  return {
    currentVersion: '2.4.141',
    downloadDirectory,
    resolveServiceUnit: () => 'pane-remote-daemon.service',
    download: vi.fn(async (_url: string, destination: string) => fs.writeFileSync(destination, PACKAGE_BYTES)),
    runDetached: vi.fn(async () => {}),
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('runCloudUpgrade', () => {
  it('does nothing when the pinned version is already running', async () => {
    const deps = dependencies();
    await expect(runCloudUpgrade(deps, { version: '2.4.141', url: 'https://x/pane.deb', sha256: PACKAGE_SHA }))
      .resolves.toEqual({ ok: true, upgraded: false, from: '2.4.141', to: '2.4.141' });
    expect(deps.download).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'linux')('verifies the package, then schedules install and restart', async () => {
    const deps = dependencies();
    const result = await runCloudUpgrade(deps, { version: '2.4.142-rc.1', debUrl: 'https://x/pane.deb', sha256: PACKAGE_SHA.toUpperCase() });

    const packagePath = path.join(deps.downloadDirectory, 'pane-2.4.142-rc.1.deb');
    expect(result).toEqual({ ok: true, upgraded: 'scheduled', from: '2.4.141', to: '2.4.142-rc.1', packagePath });
    expect(fs.readFileSync(packagePath)).toEqual(PACKAGE_BYTES);
    expect(deps.runDetached).toHaveBeenCalledWith('2-4-142-rc-1', buildUpgradeScript(packagePath, 'pane-remote-daemon.service'));
  });

  it.runIf(process.platform === 'linux')('refuses a package whose checksum does not match', async () => {
    const deps = dependencies();
    await expect(runCloudUpgrade(deps, { version: '2.4.142', url: 'https://x/pane.deb', sha256: 'a'.repeat(64) }))
      .rejects.toThrow('ERR_CLOUD_UPGRADE_CHECKSUM');
    expect(fs.readdirSync(deps.downloadDirectory)).toEqual([]);
    expect(deps.runDetached).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'linux')('refuses when the daemon is not a systemd unit', async () => {
    const deps = dependencies({ resolveServiceUnit: () => null });
    await expect(runCloudUpgrade(deps, { version: '2.4.142', url: 'https://x/pane.deb', sha256: PACKAGE_SHA }))
      .rejects.toThrow('ERR_CLOUD_UPGRADE_NO_SERVICE');
  });
});

describe('parseCloudUpgradeRequest', () => {
  it.each([
    [{ version: '2.4.142', sha256: PACKAGE_SHA }, 'An https:// package url is required'],
    [{ version: '2.4.142', url: 'http://x/pane.deb', sha256: PACKAGE_SHA }, 'An https:// package url is required'],
    [{ version: '2.4.142', url: 'https://x/pane.deb', sha256: 'abc' }, 'sha256 must be 64 hex characters'],
    [{ version: '2.4.142; rm -rf /', url: 'https://x/pane.deb', sha256: PACKAGE_SHA }, 'version has unexpected characters'],
    [{ url: 'https://x/pane.deb', sha256: PACKAGE_SHA }, 'ERR_CLOUD_UPGRADE_BAD_REQUEST'],
  ])('rejects %j', (request, message) => {
    expect(() => parseCloudUpgradeRequest(request)).toThrow(message);
  });
});

describe('resolveSystemdUnitFromCgroup', () => {
  it('finds the user service on cgroup v2', () => {
    expect(resolveSystemdUnitFromCgroup(
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/pane-remote-daemon.service\n',
    )).toBe('pane-remote-daemon.service');
  });

  it('is null outside a service', () => {
    expect(resolveSystemdUnitFromCgroup('0::/user.slice/user-1000.slice/session-3.scope\n')).toBeNull();
    expect(resolveSystemdUnitFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/init.scope\n')).toBeNull();
  });
});

describe('resolveOwnSystemdUnit', () => {
  const scopeCgroup = () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-pane-79028.scope\n';

  it('finds the Pane daemon unit when Electron moved itself into an app scope', () => {
    expect(resolveOwnSystemdUnit(scopeCgroup, () => 79028, 79028)).toBe('pane-remote-daemon.service');
  });

  it('is null when that unit runs some other process', () => {
    expect(resolveOwnSystemdUnit(scopeCgroup, () => 5, 79028)).toBeNull();
    expect(resolveOwnSystemdUnit(scopeCgroup, () => undefined, 79028)).toBeNull();
  });

  it('prefers a service named by the cgroup', () => {
    expect(resolveOwnSystemdUnit(() => '0::/user.slice/user@1000.service/app.slice/rc-loop-test.service\n', () => undefined)).toBe('rc-loop-test.service');
  });
});

describe('buildUpgradeScript', () => {
  it('quotes the package path and unit', () => {
    expect(buildUpgradeScript("/home/u/it's/pane.deb", 'pane-remote-daemon.service')).toContain(
      `apt-get install -y --allow-downgrades '/home/u/it'\\''s/pane.deb' || sudo -n dpkg -i '/home/u/it'\\''s/pane.deb'`,
    );
  });
});

describe('downloadToFile', () => {
  function streamed(chunks: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }

  it('streams the package to a 0600 file without buffering the whole body', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-cloud-download-'));
    tempDirs.push(dir);
    const response = streamed(['first-', 'second-', 'third']);
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
    const destination = path.join(dir, 'pane.deb.partial');

    await downloadToFile('https://example.test/pane.deb', destination, async () => response);

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(fs.readFileSync(destination, 'utf8')).toBe('first-second-third');
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
  });

  it('fails with the HTTP status and writes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-cloud-download-'));
    tempDirs.push(dir);
    const destination = path.join(dir, 'pane.deb.partial');
    await expect(downloadToFile('https://example.test/pane.deb', destination, async () => new Response('gone', { status: 404 })))
      .rejects.toThrow('ERR_CLOUD_UPGRADE_DOWNLOAD: Download failed with HTTP 404');
    expect(fs.existsSync(destination)).toBe(false);
  });
});
