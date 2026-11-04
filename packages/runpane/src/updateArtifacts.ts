import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveRelease } from './releases';
import { downloadArtifact } from './download';
import { detectPlatform } from './platform';
import type { UpdateHost } from './updatePreflight';
import { RunpaneError } from './errors';
import { boundary, decodeBoundary } from './boundaryDecoder';

export interface StagedApp { version: string; artifact: string; installPath: string; backupPath: string; sha256: string }
function sha(file: string): string { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function macSigner(bundle: string): string {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 60_000 });
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { encoding: 'utf8', timeout: 10_000 });
  const team = result.stderr.match(/^TeamIdentifier=(.+)$/m)?.[1];
  if (result.status !== 0 || !team || team === 'not set') throw new Error('The application has no verified signing team.');
  return team;
}
function windowsSigner(file: string): string {
  const script = `$s=Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; if ($s.Status -ne 'Valid') { throw 'Invalid application signature' }; $s.SignerCertificate.Thumbprint`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30_000 }).trim();
}

export async function stageApp(host: UpdateHost, requested: string, directory: string): Promise<StagedApp> {
  const platform = detectPlatform();
  const resolved = await resolveRelease({ version: requested, channel: 'stable', source: 'npm', platform, format: platform.os === 'darwin' ? 'zip' : platform.os === 'win32' ? 'exe' : 'appimage', target: 'client' });
  const metadata = resolved.release.assets?.find(asset => asset.name === 'continuity.json');
  if (!metadata) throw new RunpaneError('ERR_UPDATE_TARGET_PROTOCOL', 'This release does not declare the continuity protocol. Pane remains running.', 'Choose a release supporting independent updates; older installers require a manual update.');
  const response = await fetch(metadata.browser_download_url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('The release continuity manifest could not be downloaded. Pane remains running.');
  const manifest = decodeBoundary(await response.json(), boundary.object({ protocol: boundary.literal(1), version: boundary.nonEmptyString, artifacts: boundary.array(boundary.object({ name: boundary.nonEmptyString, sha256: boundary.nonEmptyString })) }));
  if (manifest.version !== resolved.release.tag_name.replace(/^v/, '')) throw new Error('The continuity manifest identifies a different release.');
  const expected = manifest.artifacts.find(item => item.name === resolved.artifact.name)?.sha256;
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error('The selected artifact is missing from the continuity manifest.');
  const downloaded = await downloadArtifact(resolved, directory);
  if (sha(downloaded.path) !== expected.toLowerCase()) throw new Error('The update artifact does not match the continuity manifest. Pane remains running.');
  const version = resolved.release.tag_name.replace(/^v/, '');
  let artifact = downloaded.path;
  const installPath = process.platform === 'darwin' ? path.resolve(host.executable, '../../..') : process.platform === 'linux' ? host.executable : path.dirname(host.executable);
  if (process.platform === 'darwin') {
    const unpacked = path.join(directory, 'unpacked');
    fs.mkdirSync(unpacked);
    execFileSync('/usr/bin/ditto', ['-x', '-k', artifact, unpacked], { timeout: 120_000 });
    artifact = path.join(unpacked, 'Pane.app');
    if (macSigner(installPath) !== macSigner(artifact)) throw new Error('The update signing team does not match the installed Pane.');
    execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', artifact], { timeout: 60_000 });
    const actual = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(artifact, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
    if (actual !== version) throw new Error('The staged app version does not match the requested release.');
  } else if (process.platform === 'win32') {
    if (windowsSigner(host.executable) !== windowsSigner(artifact)) throw new Error('The installer signer does not match the installed Pane.');
  } else {
    // The public installer historically treats checksums as optional. Independent
    // updates require one before shutting down a healthy Linux host.
    const response = await fetch(resolved.checksumUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('A release checksum is required for an independent Linux update.');
    const line = (await response.text()).split(/\r?\n/).find(item => item.trim().endsWith(downloaded.fileName));
    if (!line || line.trim().split(/\s+/)[0].toLowerCase() !== sha(artifact)) throw new Error('The AppImage release checksum is missing or invalid.');
    fs.chmodSync(artifact, 0o755);
  }
  return { version, artifact, installPath, backupPath: `${installPath}.before-${path.basename(path.dirname(directory))}`, sha256: sha(downloaded.path) };
}

/** Replacement is reconciled from owned sibling paths after a helper restart. */
export function installStagedApp(staged: StagedApp): void {
  if (process.platform === 'win32') {
    // /D is deliberately last, with no shell. NSIS owns its exact registered
    // installation and migration; failures retain the data snapshot for repair.
    // NSIS /D consumes the unquoted remainder, including spaces:
    // https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage
    const installed = spawnSync(staged.artifact, ['/S', '--updated', `/D=${staged.installPath}`], { timeout: 180_000, stdio: 'pipe', windowsVerbatimArguments: true });
    if (installed.error) throw installed.error;
    if (installed.status !== 0) throw new RunpaneError('ERR_UPDATE_INSTALL', `The installer exited with ${installed.status}. The data snapshot was retained.`, 'Inspect the operation and installer log before retrying.');
    return;
  }
  const incoming = `${staged.installPath}.incoming-${path.basename(staged.backupPath)}`;
  if (!fs.existsSync(staged.backupPath)) {
    if (fs.existsSync(incoming)) fs.rmSync(incoming, { recursive: true });
    if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', [staged.artifact, incoming], { timeout: 120_000 });
    else { fs.copyFileSync(staged.artifact, incoming); fs.chmodSync(incoming, 0o755); }
    fs.renameSync(staged.installPath, staged.backupPath);
  }
  if (!fs.existsSync(staged.installPath)) {
    if (!fs.existsSync(incoming)) throw new RunpaneError('ERR_UPDATE_RECOVERY', 'The prepared app is missing after the old installation was preserved.', `Inspect ${staged.backupPath}; do not restore old application data over a migrated database.`);
    fs.renameSync(incoming, staged.installPath);
  }
}
