import { EventEmitter } from 'events';
import {
  createDefaultRemoteDaemonHostRuntimeState,
  type RemoteDaemonConnectedClient,
  type RemoteDaemonHostConfig,
  type RemoteDaemonHostRuntimeState,
} from '../../../shared/types/remoteDaemon';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { getAppDirectory } from '../utils/appDirectory';
import { collectRemoteDaemonExecutableHealthAsync } from './remoteDaemonExecutableHealth';

interface RemoteHttpAddress {
  host: string;
  port: number;
}

export class RemoteHostRuntimeStateStore extends EventEmitter {
  constructor(private readonly collectHealth = collectRemoteDaemonExecutableHealthAsync) {
    super();
  }
  private state: RemoteDaemonHostRuntimeState = createDefaultRemoteDaemonHostRuntimeState();

  private healthRefresh: Promise<RemoteDaemonHostRuntimeState> | null = null;
  private generation = 0;
  private healthInitialized = false;

  getState(): RemoteDaemonHostRuntimeState {
    return { ...this.state };
  }

  refreshExecutableHealth(): Promise<RemoteDaemonHostRuntimeState> {
    if (this.healthRefresh) return this.healthRefresh;
    this.healthInitialized = true;
    const generation = this.generation;
    this.healthRefresh = this.collectHealth(getAppDirectory()).then(executableHealth => {
      if (generation === this.generation) {
        this.state = { ...this.state, executableHealth };
        this.emit('state-changed', this.getState());
      }
      return this.getState();
    }).finally(() => {
      if (generation === this.generation) this.healthRefresh = null;
    });
    return this.healthRefresh;
  }

  setInactive(config?: RemoteDaemonHostConfig | null): void {
    this.setState({
      enabled: config?.enabled === true,
      status: 'inactive',
      listenHost: config?.listenHost ?? null,
      listenPort: config?.listenPort ?? null,
      lastError: null,
      connectedClients: [],
      executableHealth: this.state.executableHealth,
      updatedAt: new Date().toISOString(),
    });
  }

  setLive(config: RemoteDaemonHostConfig, address?: RemoteHttpAddress | null): void {
    this.setState({
      enabled: true,
      status: 'live',
      listenHost: address?.host ?? config.listenHost,
      listenPort: address?.port ?? config.listenPort,
      lastError: null,
      connectedClients: this.state.status === 'live' ? this.state.connectedClients : [],
      executableHealth: this.state.executableHealth,
      updatedAt: new Date().toISOString(),
    });
  }

  setError<ErrorValue>(config: RemoteDaemonHostConfig | null | undefined, error: ErrorValue): void {
    this.setState({
      enabled: config?.enabled === true,
      status: 'error',
      listenHost: config?.listenHost ?? null,
      listenPort: config?.listenPort ?? null,
      lastError: getErrorMessage(error, 'Remote listener failed'),
      connectedClients: [],
      executableHealth: this.state.executableHealth,
      updatedAt: new Date().toISOString(),
    });
  }

  setConnectedClients(connectedClients: RemoteDaemonConnectedClient[]): void {
    if (this.state.status !== 'live') {
      return;
    }

    this.setState({
      ...this.state,
      connectedClients,
      updatedAt: new Date().toISOString(),
    });
  }

  resetForTests(): void {
    this.generation += 1;
    this.healthInitialized = false;
    this.healthRefresh = null;
    this.state = createDefaultRemoteDaemonHostRuntimeState();
  }

  private setState(state: RemoteDaemonHostRuntimeState): void {
    this.state = { ...state };
    if (!this.healthInitialized) {
      void this.refreshExecutableHealth().catch(error => console.error('Failed to inspect remote executable health:', error));
    }
    this.emit('state-changed', this.getState());
  }
}

function getErrorMessage<ErrorValue>(error: ErrorValue, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  try {
    const message = decodeBoundary(error, boundary.nonEmptyString).trim();
    return message;
  } catch {
    return fallback;
  }
}

export const remoteHostRuntimeStateStore = new RemoteHostRuntimeStateStore();
