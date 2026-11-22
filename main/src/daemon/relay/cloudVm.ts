import { statSync } from 'fs';

/** Set to `1` in the Pane daemon's unit on a Pane Cloud VM. */
const PANE_CLOUD_VM_ENV = 'PANE_CLOUD_VM';
/** A root-owned file the Pane Cloud guest image creates; the `pane` user can't remove it. */
const PANE_CLOUD_VM_MARKER = '/etc/pane-cloud/cloud-vm';

/**
 * Whether this Pane runs on a Pane Cloud VM, which is receive-only: it never keeps a token for
 * another computer. Either marker is enough; the file counts on Linux only. It fails closed: a marker file that exists but can't
 * be checked counts as present.
 */
export function onCloudVm(env: NodeJS.ProcessEnv = process.env, marker: string = PANE_CLOUD_VM_MARKER, platform: string = process.platform): boolean {
  const value = env[PANE_CLOUD_VM_ENV]?.trim();
  if (value && value !== '0') return true;
  // Pane Cloud VMs run Linux; elsewhere `/etc/...` may be a path any local user can create.
  if (platform !== 'linux') return false;
  try {
    statSync(marker);
    return true;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}
