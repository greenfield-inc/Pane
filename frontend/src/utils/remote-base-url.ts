import { DEFAULT_REMOTE_DAEMON_HOST_CONFIG } from '../../../shared/types/remoteDaemon';

export function formatRemoteBaseUrl(host: string, port: number): string {
  const trimmedHost = host.trim();
  const normalizedHost = trimmedHost.includes(':') && !trimmedHost.startsWith('[') ? `[${trimmedHost}]` : trimmedHost;
  return `http://${normalizedHost}:${port}`;
}

export const DEFAULT_REMOTE_BASE_URL = formatRemoteBaseUrl(
  DEFAULT_REMOTE_DAEMON_HOST_CONFIG.listenHost,
  DEFAULT_REMOTE_DAEMON_HOST_CONFIG.listenPort,
);
