import { assertUpdateCapacity } from './updateCapacity';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ParsedArgs } from './commands';
import { boundary, decodeBoundary } from './boundaryDecoder';
import { invokeDaemon, resolvePaneDirectory } from './daemonClient';
import { RunpaneError } from './errors';
import { preflightUpdate, updateHostSchema } from './updatePreflight';
import { stageUpdateRuntime } from './updateRuntime';
import { checkUpdateSupervisor, startUpdateSupervisor, removeUpdateSupervisor } from './updateSupervisor';
import { assertUpdateQuiescence, claimUpdateLock, releaseUpdateLock, executeUpdate, readUpdateJournal, updateLockReleasable, writeUpdateJson, type UpdateJournal } from './updateOperation';
import { activateManagedCli, runNpm, stageCliPackage, stageUpdateCode, type StagedCli } from './updatePackage';
import { identifyPythonCli, stagePythonCli, installPythonCli } from './updatePython';
import { stageApp, installStagedApp, type StagedApp } from './updateArtifacts';

const preflightSchema = boundary.object({
  machine: boundary.nonEmptyString, paneDir: boundary.nonEmptyString,
  scope: boundary.enumeration('both', 'pane', 'cli'), requestedVersion: boundary.nonEmptyString,
  host: boundary.nullable(updateHostSchema),
  cli: boundary.nullable(boundary.object({ owner: boundary.enumeration('managed', 'npm', 'pip'), entrypoint: boundary.nonEmptyString, version: boundary.nonEmptyString, prefix: boundary.nonEmptyString, packageManager: boundary.optional(boundary.nonEmptyString), pipUser: boundary.optional(boundary.boolean) })),
  disableOsIntegration: boundary.optional(boundary.boolean),
  npmSource: boundary.optional(boundary.nonEmptyString),
  runtimeSource: boundary.nonEmptyString, lockDirectory: boundary.nonEmptyString, additionalLockDirectories: boundary.array(boundary.nonEmptyString),
  limitations: boundary.array(boundary.string),
});
const stagedSchema = boundary.object({
  app: boundary.nullable(boundary.object({ version: boundary.string, artifact: boundary.string, installPath: boundary.string, backupPath: boundary.string, sha256: boundary.string })),
  cli: boundary.nullable(boundary.object({ version: boundary.string, archive: boundary.string, packageRoot: boundary.string })),
  npm: boundary.optional(boundary.string),
});
const terminal = (journal: UpdateJournal) => ['complete', 'needs-attention', 'failed'].includes(journal.phase);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function operationDirectory(paneDir: string, id: string): string {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new RunpaneError('ERR_UPDATE_ID', 'Invalid update operation ID. Nothing was changed.', 'Use the ID returned by runpane update.');
  return path.join(paneDir, 'updates', id);
}
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    const code = decodeBoundary(error, boundary.object({ code: boundary.optional(boundary.string) })).code;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

export async function runUpdate(parsed: ParsedArgs): Promise<number> {
  const paneDir = path.resolve(resolvePaneDirectory(parsed.paneDir));
  if (parsed.updateStatus) return presentUpdate(path.join(operationDirectory(paneDir, parsed.updateStatus), 'status.json'), parsed);
  const preflight = await preflightUpdate(parsed, parsed.updateScope ?? 'both');
  if (parsed.dryRun) { console.log(JSON.stringify({ preflight, changed: false }, null, 2)); return 0; }
  if (!parsed.json) console.log(`Updating ${preflight.scope} on ${preflight.machine}. Pane: ${preflight.host?.executable ?? 'not selected'}; CLI: ${preflight.cli ? `${preflight.cli.owner} ${preflight.cli.entrypoint}` : 'not selected'}.`);
  const id = randomUUID();
  const directory = operationDirectory(paneDir, id);
  const file = path.join(directory, 'status.json');
  writeUpdateJson(file, { id, host: preflight.machine, scope: preflight.scope, version: preflight.requestedVersion, phase: 'accepted', completed: [], setupPid: process.pid, setupExpiresAt: Date.now() + 120_000, updatedAt: new Date().toISOString(), appUpdated: false, cliUpdated: false, hostReachable: false, restored: [] });
  const acquired: string[] = [];
  try {
    for (const target of [...new Set([preflight.lockDirectory, ...preflight.additionalLockDirectories])].sort()) {
      const lock = claimUpdateLock(target, id, file);
      if (!lock.acquired) {
        for (const owned of acquired) releaseUpdateLock(owned, id);
        return presentUpdate(lock.statusFile, parsed);
      }
      acquired.push(target);
    }
  } catch (error) {
    for (const owned of acquired) releaseUpdateLock(owned, id);
    throw error;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const runtime = stageUpdateRuntime(preflight.runtimeSource, path.join(directory, 'runtime'));
    const helper = stageUpdateCode(process.argv[1], path.join(directory, 'helper'));
    writeUpdateJson(path.join(directory, 'preflight.json'), { ...preflight, runtimeSource: runtime });
    // Verify the staged helper can load every runtime import without depending
    // on the active npm package or the installed Electron executable.
    execFileSync(runtime, [helper, '--version'], { timeout: 15_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    startUpdateSupervisor({ id, directory, executable: runtime, args: [helper, '__update-runner', directory] });
    const deadline = Date.now() + 20_000;
    while (!readUpdateJournal(file).helperPid && Date.now() < deadline) await pause(100);
    if (!readUpdateJournal(file).helperPid) throw new RunpaneError('ERR_UPDATE_HELPER_NOT_READY', 'The supervisor did not acknowledge startup. Pane was not shut down.', `Inspect ${directory} and retry after resolving the supervisor error.`);
  } catch (error) {
    // A queued task must not wake later and shut down a host after its caller
    // reported failure. Fence independently of the mutable journal: a helper
    // may be publishing its acknowledgment concurrently with this failure.
    writeUpdateJson(path.join(directory, 'canceled.json'), { id, reason: error instanceof Error ? error.message : String(error) });
    // A supervisor command can fail after launching its task. Once the helper
    // acknowledged, it owns reconciliation and any post-shutdown locks; never
    // overwrite its progress or release those locks from the requesting CLI.
    if (readUpdateJournal(file).helperPid) return presentUpdate(file, parsed);
    writeUpdateJson(file, { ...readUpdateJournal(file), phase: 'failed', error: error instanceof Error ? error.message : String(error) });
    try { removeUpdateSupervisor(id); } catch { /* the operation is durably failed */ }
    for (const lock of [preflight.lockDirectory, ...preflight.additionalLockDirectories]) releaseUpdateLock(lock, id);
    throw error;
  }
  return presentUpdate(file, parsed);
}

async function presentUpdate(file: string, parsed: ParsedArgs): Promise<number> {
  let journal = readUpdateJournal(file);
  if (parsed.updateWait) {
    while (!terminal(journal)) { await pause(500); journal = readUpdateJournal(file); }
  }
  console.log(JSON.stringify({ ...journal, statusFile: file, next: `runpane update --status ${journal.id} --pane-dir ${JSON.stringify(path.dirname(path.dirname(path.dirname(file))))} --wait --json` }, null, 2));
  return journal.phase === 'failed' || journal.phase === 'needs-attention' ? 1 : 0;
}

/** Entry point executed solely from the independently staged code and runtime. */
export interface UpdateArtifactStager {
  stageApplication: typeof stageApp;
}

export async function runUpdateHelper(directory: string, artifacts: UpdateArtifactStager = { stageApplication: stageApp }): Promise<number> {
  const file = path.join(directory, 'status.json');
  const preflight = decodeBoundary(JSON.parse(fs.readFileSync(path.join(directory, 'preflight.json'), 'utf8')), preflightSchema);
  const options = { paneDir: preflight.paneDir, timeoutMs: 15_000 };
  const host = preflight.host;
  const id = readUpdateJournal(file).id;
  if (path.resolve(directory) !== operationDirectory(preflight.paneDir, id)) throw new Error('Update operation path does not match its target.');
  const request = { id, bootId: host?.bootId ?? '' };
  const manifest = path.join(directory, 'staged.json');
  const result = await executeUpdate(file, { run: async (step, journal) => {
    if (step === 'stage') {
      checkUpdateSupervisor();
      if (fs.existsSync(manifest)) {
        const staged = decodeBoundary(JSON.parse(fs.readFileSync(manifest, 'utf8')), stagedSchema);
        return { version: staged.app?.version ?? staged.cli!.version };
      }
      for (const folder of ['app', 'cli']) fs.rmSync(path.join(directory, folder), { recursive: true, force: true });
      let app: StagedApp | null = null;
      let cli: StagedCli | null = null;
      const npm = preflight.npmSource;
      if (host) app = await artifacts.stageApplication(host, preflight.requestedVersion, path.join(directory, 'app'));
      if (preflight.cli) cli = preflight.cli.owner === 'pip'
        ? stagePythonCli(preflight.cli.packageManager!, app?.version ?? preflight.requestedVersion, path.join(directory, 'cli'))
        : stageCliPackage(preflight.runtimeSource, npm!, app?.version ?? preflight.requestedVersion, path.join(directory, 'cli'));
      if (preflight.cli?.owner === 'pip' && cli) execFileSync(preflight.cli.packageManager!, ['-m', 'pip', 'install', '--dry-run', '--no-index', '--no-deps', ...(preflight.cli.pipUser ? ['--user'] : []), cli.archive], { timeout: 30_000, stdio: 'pipe' });
      writeUpdateJson(manifest, { app, cli, npm });
      return { version: app?.version ?? cli!.version };
    }
    const staged = decodeBoundary(JSON.parse(fs.readFileSync(manifest, 'utf8')), stagedSchema);
    if (step === 'checkpoint' && host) {
      assertUpdateCapacity(preflight.paneDir, host, staged.app!.installPath, preflight.cli?.prefix);
      const current = await invokeDaemon('runpane:update:host', [], updateHostSchema, options);
      if (current.bootId !== host.bootId || current.executable !== host.executable || current.endpointFingerprint !== host.endpointFingerprint) throw new Error('The target host changed after preflight. Pane remains running.');
      await invokeDaemon('runpane:update:checkpoint', [request], boundary.jsonObject, options);
    }
    if (step === 'stop' && host) {
      // Reconcile an acknowledged stop after a helper restart. Never kill a
      // reused PID, another Pane installation, or a replacement daemon.
      if (processExists(host.pid)) {
        try { await invokeDaemon('runpane:update:stop', [request], boundary.object({ accepted: boundary.boolean }), options); }
        catch (error) { if (processExists(host.pid)) throw error; }
      }
      const deadline = Date.now() + 30_000;
      while (processExists(host.pid) && Date.now() < deadline) await pause(200);
      if (processExists(host.pid)) throw new Error('Pane did not exit within 30 seconds. No installer was started. Inspect the host before retrying.');
      assertUpdateQuiescence(directory, { id, bootId: host.bootId, pid: host.pid });
    }
    if (step === 'snapshot' && host) {
      const snapshot = path.join(directory, 'snapshot');
      const ready = path.join(snapshot, 'complete.json');
      if (!fs.existsSync(ready)) {
        fs.rmSync(snapshot, { recursive: true, force: true });
        fs.mkdirSync(snapshot, { recursive: true, mode: 0o700 });
        for (const [name, source] of [['data', host.paneDir], ['profile', host.userData]]) {
          const target = path.join(snapshot, name);
          fs.mkdirSync(target, { recursive: true, mode: 0o700 });
          for (const entry of fs.readdirSync(source)) {
            if (source === host.paneDir && entry === 'updates') continue;
            fs.cpSync(path.join(source, entry), path.join(target, entry), { recursive: true, verbatimSymlinks: true, filter: file => !fs.lstatSync(file).isSocket() && !path.basename(file).startsWith('Singleton') });
          }
        }
        writeUpdateJson(ready, { version: host.version, createdAt: new Date().toISOString() });
      }
    }
    if (step === 'install') {
      if (staged.app) {
        installStagedApp(staged.app);
        writeUpdateJson(file, { ...readUpdateJournal(file), appUpdated: true });
      }
      if (staged.cli && preflight.cli) {
        if (preflight.cli.owner === 'pip') installPythonCli(preflight.cli.packageManager!, staged.cli.archive, preflight.cli.pipUser ?? false);
        else if (preflight.cli.owner === 'npm') runNpm(preflight.runtimeSource, staged.npm!, ['install', '--global', '--prefix', preflight.cli.prefix, '--ignore-scripts', '--offline', staged.cli.archive]);
        else {
          const target = path.join(preflight.cli.prefix, 'cli', id);
          const packageRoot = path.join(target, 'package');
          fs.mkdirSync(target, { recursive: true, mode: 0o700 });
          fs.cpSync(staged.cli.packageRoot, packageRoot, { recursive: true });
          const runtimeDirectory = path.join(target, 'runtime');
          const runtime = fs.existsSync(runtimeDirectory) ? path.join(runtimeDirectory, process.platform === 'win32' ? 'node.exe' : 'node') : stageUpdateRuntime(preflight.runtimeSource, runtimeDirectory);
          activateManagedCli(preflight.paneDir, staged.cli.version, path.join(packageRoot, 'dist/cli.js'), runtime);
        }
      }
      return { appUpdated: Boolean(staged.app), cliUpdated: Boolean(staged.cli) };
    }
    if (step === 'launch' && host) {
      let running = false;
      try { const current = await invokeDaemon('runpane:update:host', [], updateHostSchema, options); running = current.bootId !== host.bootId; } catch { /* expected after shutdown */ }
      if (!running) {
        const env: NodeJS.ProcessEnv = { PANE_DIR: preflight.paneDir };
        if (preflight.disableOsIntegration) env.PANE_DISABLE_OS_INTEGRATION = '1';
        delete env.ELECTRON_RUN_AS_NODE;
        if (process.platform === 'darwin') {
          execFileSync('/usr/bin/open', ['-n', '-a', path.resolve(host.executable, '../../..'), '--env', `PANE_DIR=${preflight.paneDir}`, ...(preflight.disableOsIntegration ? ['--env', 'PANE_DISABLE_OS_INTEGRATION=1'] : []), '--args', `--user-data-dir=${host.userData}`], { timeout: 30_000 });
        } else {
          // Relaunch has its own supervisor lifetime. Completing/removing the
          // updater task must not tear down the new app with the helper's job.
          const launcher = path.join(directory, 'launch-app.cjs');
          fs.writeFileSync(launcher, `const {spawn}=require('node:child_process');const env={...process.env,...${JSON.stringify(env)}};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(${JSON.stringify(host.executable)},${JSON.stringify([`--user-data-dir=${host.userData}`])},{stdio:'ignore',env});child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code||0));`, { mode: 0o600 });
          startUpdateSupervisor({ id: `${id}-app`, directory, executable: preflight.runtimeSource, args: [launcher] });
        }
      }
    }
    if (step === 'health' && staged.cli && preflight.cli) {
      const actual = preflight.cli.owner === 'pip'
        ? identifyPythonCli(preflight.cli.packageManager!, preflight.cli.entrypoint).version
        : execFileSync(preflight.runtimeSource, [preflight.cli.owner === 'managed' ? path.join(preflight.cli.prefix, 'cli', id, 'package/dist/cli.js') : preflight.cli.entrypoint, '--version'], { encoding: 'utf8', timeout: 15_000 }).trim().split(/\s+/).pop();
      if (actual !== staged.cli.version) throw new Error(`The active CLI reports ${actual}, expected ${staged.cli.version}.`);
    }
    if (step === 'health' && host) {
      const deadline = Date.now() + 90_000;
      let failure = '';
      while (Date.now() < deadline) {
        try {
          const current = await invokeDaemon('runpane:update:host', [], updateHostSchema, options);
          if (!current.remoteHealthy || current.bootId === host.bootId || current.version !== journal.version || current.paneDir !== host.paneDir || current.userData !== host.userData || current.executable !== host.executable || current.endpointFingerprint !== host.endpointFingerprint) throw new Error('Relaunched host version, identity, or endpoint/auth configuration does not match.');
          if (process.platform === 'win32') removeUpdateSupervisor(`${id}-app`);
          return { hostReachable: true };
        } catch (error) { failure = error instanceof Error ? error.message : String(error); await pause(500); }
      }
      throw new Error(`The new host failed its health check: ${failure}. The data snapshot is preserved; no automatic database downgrade was attempted.`);
    }
    if (step === 'restore' && host) {
      const deadline = Date.now() + 30 * 60_000;
      while (Date.now() < deadline) {
        const progress = await invokeDaemon('runpane:update:restore', [{ id }], boundary.object({ complete: boundary.boolean, restored: boundary.array(boundary.object({ panelId: boundary.string, outcome: boundary.string, reason: boundary.string })) }), options);
        writeUpdateJson(file, { ...readUpdateJournal(file), restored: progress.restored });
        if (progress.complete) return { restored: progress.restored };
        await pause(500);
      }
      throw new Error('Panel restoration exceeded its deadline. Durable per-panel progress is preserved; inspect the operation before taking further action.');
    }
    return {};
  } });
  if (terminal(result)) {
    // A new operation gets its own directory, so this journal and snapshot stay.
    if (updateLockReleasable(result)) for (const lock of [preflight.lockDirectory, ...preflight.additionalLockDirectories]) releaseUpdateLock(lock, id);
    try { removeUpdateSupervisor(id); } catch { /* terminal journal prevents another execution */ }
  }
  return result.phase === 'complete' ? 0 : 1;
}
