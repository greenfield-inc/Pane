import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { onCloudVm } from './cloudVm';

describe('whether Pane runs on a Pane Cloud VM', () => {
  const folders: string[] = [];
  const folder = () => {
    const made = mkdtempSync(join(tmpdir(), 'pane-cloud-vm-'));
    folders.push(made);
    return made;
  };
  afterEach(() => {
    for (const made of folders.splice(0)) {
      chmodSync(made, 0o700);
      rmSync(made, { recursive: true, force: true });
    }
  });

  it('is not a VM with neither marker', () => {
    expect(onCloudVm({}, join(folder(), 'cloud-vm'), 'linux')).toBe(false);
    expect(onCloudVm({ PANE_CLOUD_VM: '0' }, join(folder(), 'cloud-vm'), 'linux')).toBe(false);
  });

  it('is a VM when the unit sets PANE_CLOUD_VM=1', () => {
    expect(onCloudVm({ PANE_CLOUD_VM: '1' }, join(folder(), 'cloud-vm'), 'win32')).toBe(true);
  });

  it('is a VM when the marker file exists, whatever the environment says', () => {
    const marker = join(folder(), 'cloud-vm');
    writeFileSync(marker, '');
    expect(onCloudVm({ PANE_CLOUD_VM: '0' }, marker, 'linux')).toBe(true);
  });

  it('ignores a marker file off Linux, where any local user may create one', () => {
    const marker = join(folder(), 'cloud-vm');
    writeFileSync(marker, '');
    expect(onCloudVm({}, marker, 'win32')).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('fails closed: a marker it cannot check counts as a VM', () => {
    const locked = folder();
    chmodSync(locked, 0o000);
    expect(onCloudVm({}, join(locked, 'cloud-vm'), 'linux')).toBe(true);
  });
});
