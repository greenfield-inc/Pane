import { isDaemonOwnedChannel } from './daemonChannels';
import type { IpcMainInvokeEvent } from 'electron';
import { AsyncLocalStorage } from 'async_hooks';

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
      throw new Error(`No Pane daemon command registered for channel "${channel}"`);
    }

    return handler(...args);
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

    ipcMain.handle(channel, (_event, ...args) => this.invoke(channel, args));
    this.boundChannels.add(channel);
  }

  bindChannels(ipcMain: IpcMainHandleLike, channels: readonly string[]): void {
    for (const channel of channels) {
      this.bindChannel(ipcMain, channel);
    }
  }
}
