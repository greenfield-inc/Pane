import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs';
import path from 'path';
import { PaneError } from '../../../shared/paneError';
import { decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { isRemotePaneCommand, teammatePaneCaller, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { DeviceService } from '../services/devices/deviceService';
import { applySnapshot, checkoutHas } from '../services/devices/deviceSync';
import { MAC_DEVICES_CHANNEL, macDeviceRequestSchema } from '../services/devices/remoteDevices';

const RUN_WAIT_MS = 120_000;
/** Every answer comes within this long, under the linked computer's idle limit; slower calls become tasks. */
const ANSWER_WITHIN_MS = 10_000;
/** A task's result waits this long for the computer that started it. */
const TASK_KEEP_MS = 15 * 60_000;

type Outcome = { value: PaneCommandValue } | { error: Error };
const tasks = new Map<string, { key: string; outcome: Promise<Outcome>; expires: number }>();

/** `work`'s result if it settles within the answer window, else `{ pending: <task> }` to await. */
async function answerWithin(key: string, work: Promise<PaneCommandValue>): Promise<PaneCommandValue> {
  const now = Date.now();
  for (const [id, task] of tasks) if (task.expires < now) tasks.delete(id);
  const outcome = work.then((value): Outcome => ({ value }), (cause): Outcome => ({ error: cause instanceof Error ? cause : new Error(String(cause)) }));
  const settled = await settledWithin(outcome);
  if (settled) return unwrap(settled);
  const id = randomUUID();
  tasks.set(id, { key, outcome, expires: now + TASK_KEEP_MS });
  return { pending: id };
}

/** The task's result once it settles within the answer window, else `{ pending }` again. */
async function awaitTask(key: string, id: string | undefined): Promise<PaneCommandValue> {
  const task = id ? tasks.get(id) : undefined;
  if (!id || !task || task.key !== key) throw new PaneError('ERR_DEVICE_TASK_GONE', 'The Mac no longer has that device call.', 'Call the device tool again.');
  const settled = await settledWithin(task.outcome);
  if (!settled) return { pending: id };
  tasks.delete(id);
  return unwrap(settled);
}

function settledWithin(outcome: Promise<Outcome>): Promise<Outcome | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const window = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ANSWER_WITHIN_MS); });
  return Promise.race([outcome, window]).finally(() => clearTimeout(timer));
}

function unwrap(outcome: Outcome): PaneCommandValue {
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}


/** "device-qa on DEVBOX" for each linked computer's Pane, so busy errors and tabs name the holder. */
const remotePaneNames = new Map<string, string>();

export function remotePaneName(key: string): string | undefined {
  return remotePaneNames.get(key);
}

function safe(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * This Mac's devices for the owner's other computers (`runpane:machine:devices`). The HTTP
 * listeners admit `runpane:machine:` only for a linked computer's token or the owner, never a
 * phone. Leases, checkouts and jobs are keyed by the calling computer and its Pane.
 */
export function registerMacDeviceHandler(commandRegistry: PaneCommandRegistry, devices: () => DeviceService, root: string): void {
  commandRegistry.register(MAC_DEVICES_CHANNEL, async (raw: PaneCommandValue) => {
    if (!isRemotePaneCommand() || teammatePaneCaller()) {
      throw new PaneError('ERR_DEVICE_LINKED_ONLY', 'This channel answers only the owner\'s linked computers. Nothing ran.', 'Use runpane devices from a Pane tab on this machine.');
    }
    const request = decodeBoundary(raw, macDeviceRequestSchema);
    const key = `${safe(request.from.id)}:${safe(request.paneId)}`;
    const caller = { paneId: key, paneName: `${request.paneName ?? request.paneId} on ${request.from.name}` };
    if (request.paneName) remotePaneNames.set(key, caller.paneName);
    const checkout = path.join(root, 'checkouts', `${safe(request.from.id)}-${safe(request.paneId)}`);
    const upload = `${checkout}.bundle`;
    const service = devices();
    if (request.op === 'await') return awaitTask(key, request.task);
    return answerWithin(key, handle());

    async function handle(): Promise<PaneCommandValue> {
      switch (request.op) {
        case 'probe': {
          const capabilities = await service.probe();
          return { ios: capabilities.ios.ready, android: capabilities.android.ready };
        }
        case 'list':
          return { devices: await service.list() };
        case 'open': {
          if (!request.platform) throw new PaneError('ERR_DEVICE_INVALID_REQUEST', 'open needs a platform.', 'Update Pane on both computers.');
          return service.open(caller, request.device ? { platform: request.platform, device: request.device } : { platform: request.platform });
        }
        case 'screenshot': {
          const shot = await service.screenshot(caller);
          const data = readFileSync(shot.path).toString('base64');
          rmSync(shot.path, { force: true });
          return { ...shot, data };
        }
        case 'act':
          return service.act(caller, request.args ?? []);
        case 'stream': {
          const id = service.held(key);
          const info = await service.stream(id);
          const url = new URL(info.streamUrl);
          const input = new URL(info.inputUrl);
          // The hub's port, for the caller's tunnel; its token goes only to the owner's linked computer.
          return { port: Number(url.port), token: info.token, path: `${url.pathname}${url.search}`, inputPath: `${input.pathname}${input.search}` };
        }
        case 'visible': {
          const id = service.lifecycle.leaseOf(key);
          if (id) service.lifecycle.setVisible(key, id, request.from.id, request.visible === true);
          return { ok: true };
        }
        case 'frame':
          return { data: (await service.latestFrame(service.held(key))).toString('base64') };
        case 'sync-begin':
          rmSync(upload, { force: true });
          return { has: request.base ? await checkoutHas(checkout, request.base) : false };
        case 'sync-chunk': {
          const size = existsSync(upload) ? statSync(upload).size : 0;
          if (request.offset !== size || request.data === undefined) throw new PaneError('ERR_DEVICE_SYNC', `The upload arrived out of order (expected byte ${size}).`, 'Call device_run again; Pane sends the whole snapshot again.');
          mkdirSync(path.dirname(upload), { recursive: true });
          appendFileSync(upload, Buffer.from(request.data, 'base64'));
          return { received: statSync(upload).size };
        }
        case 'sync-end': {
          if (!request.commit || !existsSync(upload) || statSync(upload).size !== request.bytes) throw new PaneError('ERR_DEVICE_SYNC', 'The snapshot did not arrive whole.', 'Call device_run again.');
          await applySnapshot(checkout, upload, request.commit);
          rmSync(upload, { force: true });
          return { synced: request.commit };
        }
        case 'run': {
          service.held(key);
          if (!request.command) throw new PaneError('ERR_DEVICE_INVALID_REQUEST', 'run needs a command.', 'Pass a command.');
          const background = request.background === true;
          const job = await service.run(key, request.command, checkout, { background, waitMs: request.waitMs ?? RUN_WAIT_MS });
          return job.exitCode === undefined
            ? { jobId: job.jobId, state: job.state, logTail: job.logTail, cwd: checkout }
            : { jobId: job.jobId, state: job.state, logTail: job.logTail, cwd: checkout, exitCode: job.exitCode };
        }
        case 'close':
          return service.close(caller);
        case 'archived':
          await service.paneArchived(key);
          rmSync(checkout, { recursive: true, force: true });
          rmSync(upload, { force: true });
          return { archived: true };
      }
    }
  });
}
