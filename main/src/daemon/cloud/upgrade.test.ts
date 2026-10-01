import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareDebianVersions, MIN_CLOUD_PIN_PANE_VERSION, type CloudPanePin } from './panePin';
import {
  buildUpgradeScript,
  downloadToFile,
  parseCloudUpgradeRequest,
  readPanePinFile,
  resolveOwnSystemdUnit,
  resolveSystemdUnitFromCgroup,
  runCloudUpgrade,
  type CloudUpgradeDependencies,
} from './upgrade';

const PACKAGE_BYTES = Buffer.from('fake deb');
const PACKAGE_SHA = createHash('sha256').update(PACKAGE_BYTES).digest('hex');
const NEXT_VERSION = '2.4.142-rc.1';
const PIN: CloudPanePin = { version: NEXT_VERSION, url: 'https://x/pane.deb', sha256: PACKAGE_SHA };
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-cloud-upgrade-'));
  tempDirs.push(dir);
  return dir;
}

function dependencies(overrides: Partial<CloudUpgradeDependencies> = {}): CloudUpgradeDependencies {
  return {
    currentVersion: '2.4.141',
    downloadDirectory: tempDir(),
    readPin: () => PIN,
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
    const result = await runCloudUpgrade(deps, { version: NEXT_VERSION, debUrl: 'https://x/pane.deb', sha256: PACKAGE_SHA.toUpperCase() });

    const packagePath = path.join(deps.downloadDirectory, 'pane-2.4.142-rc.1.deb');
    expect(result).toEqual({ ok: true, upgraded: 'scheduled', from: '2.4.141', to: '2.4.142-rc.1', packagePath });
    expect(fs.readFileSync(packagePath)).toEqual(PACKAGE_BYTES);
    expect(deps.runDetached).toHaveBeenCalledWith('2-4-142-rc-1', buildUpgradeScript(packagePath, 'pane-remote-daemon.service'));
  });

  it.runIf(process.platform === 'linux')('refuses a package whose checksum does not match', async () => {
    const deps = dependencies({ readPin: () => ({ ...PIN, sha256: 'a'.repeat(64) }) });
    await expect(runCloudUpgrade(deps, { ...PIN, sha256: 'a'.repeat(64) }))
      .rejects.toThrow('ERR_CLOUD_UPGRADE_CHECKSUM');
    expect(fs.readdirSync(deps.downloadDirectory)).toEqual([]);
    expect(deps.runDetached).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'linux')('refuses when the daemon is not a systemd unit', async () => {
    const deps = dependencies({ resolveServiceUnit: () => null });
    await expect(runCloudUpgrade(deps, PIN)).rejects.toThrow('ERR_CLOUD_UPGRADE_NO_SERVICE');
  });

  it('installs nothing when this Session has no pin', async () => {
    const deps = dependencies({ readPin: () => null });
    await expect(runCloudUpgrade(deps, PIN)).rejects.toThrow('ERR_CLOUD_UPGRADE_NOT_PINNED');
    expect(deps.download).not.toHaveBeenCalled();
  });

  it.each([
    ['another url', { ...PIN, url: 'https://attacker.example/evil.deb' }],
    ['another checksum', { ...PIN, sha256: 'b'.repeat(64) }],
    ['another version', { ...PIN, version: '2.4.143' }],
  ])('refuses a request for %s than the Session pinned', async (_what, request) => {
    const deps = dependencies();
    await expect(runCloudUpgrade(deps, request)).rejects.toThrow('ERR_CLOUD_UPGRADE_NOT_PINNED');
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.runDetached).not.toHaveBeenCalled();
  });

  it('refuses a pin older than the first Pane that enforces client scopes', async () => {
    const old = { ...PIN, version: '2.4.141' };
    const deps = dependencies({ currentVersion: NEXT_VERSION, readPin: () => old });
    await expect(runCloudUpgrade(deps, old)).rejects.toThrow('ERR_CLOUD_UPGRADE_TOO_OLD');
    expect(deps.download).not.toHaveBeenCalled();
  });
});

describe('readPanePinFile', () => {
  const pinJson = JSON.stringify(PIN);
  const rootStat = { uid: 0, mode: 0o100644 };

  function writePin(text: string): string {
    const file = path.join(tempDir(), 'pane-pin.json');
    fs.writeFileSync(file, text);
    return file;
  }

  it('reads a root-owned pin', () => {
    expect(readPanePinFile(writePin(pinJson), () => rootStat)).toEqual(PIN);
  });

  it('is null when no pin was written', () => {
    expect(readPanePinFile(path.join(tempDir(), 'missing.json'))).toBeNull();
  });

  it.each([
    ['not owned by root', { uid: 1000, mode: 0o100644 }],
    ['group-writable', { uid: 0, mode: 0o100664 }],
    ['world-writable', { uid: 0, mode: 0o100646 }],
  ])('refuses a pin file that is %s', (_what, stat) => {
    expect(() => readPanePinFile(writePin(pinJson), () => stat)).toThrow('ERR_CLOUD_UPGRADE_PIN_UNSAFE');
  });

  it('refuses a malformed pin', () => {
    expect(() => readPanePinFile(writePin('{"version":"2.4.142"}'), () => rootStat)).toThrow('ERR_CLOUD_UPGRADE_PIN_INVALID');
    expect(() => readPanePinFile(writePin(JSON.stringify({ ...PIN, url: 'http://x/pane.deb' })), () => rootStat))
      .toThrow('ERR_CLOUD_UPGRADE_PIN_INVALID');
  });
});

describe('compareDebianVersions', () => {
  // Each pair checked against `dpkg --compare-versions <a> lt <b>`.
  it.each([
    ['2.4.141', '2.4.142'],
    ['2.4.141', MIN_CLOUD_PIN_PANE_VERSION],
    ['2.4.141-rc.20260929235959.gdeadbeef', MIN_CLOUD_PIN_PANE_VERSION],
    [MIN_CLOUD_PIN_PANE_VERSION, '2.4.141-rc.20261001024355.gae1fd722'],
    ['2.4.141-rc.20261001024355.gae1fd722', '2.4.142'],
    ['2.4.9', '2.4.10'],
    ['1.0~rc1', '1.0'],
    ['1.0', '1.0a'],
    ['1.0a', '1.0+b1'],
    ['9.9', '1:0.1'],
  ])('%s < %s', (lower, higher) => {
    expect(compareDebianVersions(lower, higher)).toBeLessThan(0);
    expect(compareDebianVersions(higher, lower)).toBeGreaterThan(0);
  });

  it('treats leading zeros as equal', () => {
    expect(compareDebianVersions('2.04.141', '2.4.141')).toBe(0);
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
    expect(resolveOwnSystemdUnit(() => '0::/user.slice/user@1000.service/app.slice/pane-test.service\n', () => undefined)).toBe('pane-test.service');
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
