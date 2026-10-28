import { REMOTE_READ_CHANNELS } from '../../../shared/remoteClient/readChannels';
import { isDaemonOwnedChannel } from './daemonChannels';
import type { IpcMainInvokeEvent } from 'electron';
import { AsyncLocalStorage } from 'async_hooks';
import { PaneError, paneErrorText } from '../../../shared/paneError';

const invocationSignal = new AsyncLocalStorage<AbortSignal>();

export function paneCommandSignal(): AbortSignal | undefined {
  return invocationSignal.getStore();
}

const remoteInvocation = new AsyncLocalStorage<boolean>();

export function isRemotePaneCommand(): boolean {
  return remoteInvocation.getStore() === true;
}

type PaneCommandObject = object;
export type PaneCommandValue = PaneCommandObject | string | number | boolean | null | undefined;

export type PaneCommandHandler<
  TArgs extends PaneCommandValue[] = PaneCommandValue[],
  TResult extends PaneCommandValue = PaneCommandValue,
> = (
  ...args: TArgs
) => Promise<TResult> | TResult;

type RegisteredPaneCommandHandler = {
  invoke(...args: PaneCommandValue[]): Promise<PaneCommandValue> | PaneCommandValue;
}['invoke'];

interface IpcMainHandleLike {
  handle(
    channel: string,
    listener: (_event: IpcMainInvokeEvent, ...args: PaneCommandValue[]) => Promise<PaneCommandValue> | PaneCommandValue,
  ): void;
}

export class PaneCommandRegistry {
  private updateQuiescing = false;
  private readonly mutations = new Set<Promise<PaneCommandValue>>();

  async quiesceForUpdate(): Promise<void> {
    this.updateQuiescing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.mutations]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('In-flight work did not settle; Pane remains running.')), 10_000); }),
      ]);
    } catch (error) { this.updateQuiescing = false; throw error; }
    finally { if (timer) clearTimeout(timer); }
  }

  cancelUpdateQuiescence(): void { this.updateQuiescing = false; }

  private readonly handlers = new Map<string, RegisteredPaneCommandHandler>();
  private readonly boundChannels = new Set<string>();

  register<TArgs extends PaneCommandValue[], TResult extends PaneCommandValue>(
    channel: string,
    handler: PaneCommandHandler<TArgs, TResult>,
  ): void {
    if (!isDaemonOwnedChannel(channel)) {
      throw new Error(`Cannot register non-daemon-owned channel "${channel}" in PaneCommandRegistry`);
    }

    if (this.handlers.has(channel)) {
      throw new Error(`Pane daemon command "${channel}" is already registered`);
    }

    this.handlers.set(channel, handler);
  }

  has(channel: string): boolean {
    return this.handlers.has(channel);
  }

  listChannels(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async invoke(channel: string, args: readonly PaneCommandValue[] = []): Promise<PaneCommandValue> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new PaneError(
        'ERR_UNKNOWN_CHANNEL',
        `No Pane daemon command registered for channel "${channel}". This Pane does not have that command, usually because it is older than the runpane CLI or app that asked. Nothing was changed.`,
        'Update Pane with `runpane update`, then restart it.',
      );
    }

    // A notify call waits for a person for hours; an update ends it like any other disconnect.
    const mutation = !REMOTE_READ_CHANNELS.has(channel) && !channel.startsWith('runpane:update:') && channel !== 'runpane:notify';
    if (mutation && this.updateQuiescing) throw new PaneError('ERR_UPDATE_QUIESCING', 'Pane is saving this workspace for an update. The action was not sent.', 'Wait for the update to reconnect before submitting it.');
    const result = Promise.resolve(handler(...args));
    if (mutation) this.mutations.add(result);
    try { return await result; } finally { this.mutations.delete(result); }
  }

  /** Transport-owned cancellation cannot be supplied through request arguments. */
  invokeConnected(channel: string, args: readonly PaneCommandValue[], signal: AbortSignal): Promise<PaneCommandValue> {
    return invocationSignal.run(signal, () => this.invoke(channel, args));
  }

  /** Provenance is set by the HTTP transport, never by caller-supplied arguments. */
  invokeRemote(channel: string, args: readonly PaneCommandValue[] = []): Promise<PaneCommandValue> {
    return remoteInvocation.run(true, () => this.invoke(channel, args));
  }

  bindChannel(ipcMain: IpcMainHandleLike, channel: string): void {
    if (!this.handlers.has(channel)) {
      throw new Error(`Cannot bind unregistered Pane daemon command "${channel}"`);
    }

    if (this.boundChannels.has(channel)) {
      throw new Error(`Pane daemon command "${channel}" is already bound to IPC`);
    }

    ipcMain.handle(channel, (_event, ...args) => rejectWithPaneErrorText(this.invoke(channel, args)));
    this.boundChannels.add(channel);
  }

  bindChannels(ipcMain: IpcMainHandleLike, channels: readonly string[]): void {
    for (const channel of channels) {
      this.bindChannel(ipcMain, channel);
    }
  }
}

/** Electron IPC keeps only an error's message, so a PaneError's next step joins its message. */
export async function rejectWithPaneErrorText<T>(result: Promise<T>): Promise<T> {
  try {
    return await result;
  } catch (error) {
    throw error instanceof PaneError ? new Error(paneErrorText(error)) : error;
  }
}
