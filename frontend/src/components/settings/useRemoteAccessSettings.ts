import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createDefaultRemoteDaemonConfig,
  createDefaultRemoteDaemonHostRuntimeState,
  createDefaultRemotePaneConnectionState,
  type RemoteDaemonConfig,
  type RemoteDaemonHostConfig,
  type RemoteDaemonHostRuntimeState,
  type RemoteHostSetupRequest,
  type RemoteHostSetupResult,
  type RemotePaneConnectionProfile,
  type RemotePaneConnectionState,
  type RemoteSetupDataDirectoryMode,
  type RemoteSetupTunnelPreference,
} from '../../../../shared/types/remoteDaemon';
import { API } from '../../utils/api';
import { panelApi } from '../../services/panelApi';
import { useConfigStore } from '../../stores/configStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { RemoteAccessSubviewId } from '../../types/settings';

interface RemoteHostSetupDraft {
  dataMode: RemoteSetupDataDirectoryMode;
  label: string;
  listenPort: number;
  paneDir: string;
  tunnelPreference: RemoteSetupTunnelPreference;
  manualBaseUrl: string;
  installService: boolean;
}

type RemoteActionOutcome<T> =
  | { success: true; value: T }
  | { success: false };

const DEFAULT_HOST_SETUP_DRAFT: RemoteHostSetupDraft = {
  dataMode: 'current',
  label: '',
  listenPort: 42137,
  paneDir: '',
  tunnelPreference: 'tailscale',
  manualBaseUrl: '',
  installService: true,
};

function formatRemoteBaseUrl(host: string, port: number): string {
  const trimmedHost = host.trim();
  const normalizedHost = trimmedHost.includes(':') && !trimmedHost.startsWith('[') ? `[${trimmedHost}]` : trimmedHost;
  return `http://${normalizedHost}:${port}`;
}

export function useRemoteAccessSettings(isOpen: boolean, closeSettings: () => void) {
  const [config, setConfig] = useState<RemoteDaemonConfig>(createDefaultRemoteDaemonConfig);
  const configRef = useRef(config);
  const [connectionState, setConnectionState] = useState<RemotePaneConnectionState>(createDefaultRemotePaneConnectionState);
  const [hostState, setHostState] = useState<RemoteDaemonHostRuntimeState>(createDefaultRemoteDaemonHostRuntimeState);
  const [hostDraft, setHostDraft] = useState<RemoteDaemonHostConfig>(() => createDefaultRemoteDaemonConfig().host.config);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [setupResult, setSetupResult] = useState<RemoteHostSetupResult | null>(null);

  const [setupDataMode, setSetupDataMode] = useState<RemoteSetupDataDirectoryMode>('current');
  const [setupLabel, setSetupLabel] = useState('');
  const [setupListenPort, setSetupListenPort] = useState(42137);
  const [setupPaneDir, setSetupPaneDir] = useState('');
  const [setupTunnelPreference, setSetupTunnelPreference] = useState<RemoteSetupTunnelPreference>('tailscale');
  const [setupManualBaseUrl, setSetupManualBaseUrl] = useState('');
  const [setupInstallService, setSetupInstallService] = useState(true);
  const [setupBaseline, setSetupBaseline] = useState(DEFAULT_HOST_SETUP_DRAFT);

  const [connectionCode, setConnectionCode] = useState('');
  const [pairLabel, setPairLabel] = useState('');
  const [pairBaseUrl, setPairBaseUrl] = useState('http://127.0.0.1:42137');
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [profileLabel, setProfileLabel] = useState('');
  const [profileBaseUrl, setProfileBaseUrl] = useState('http://127.0.0.1:42137');
  const [profileToken, setProfileToken] = useState('');

  const refreshConfigStore = useConfigStore((state) => state.fetchConfig);
  const activeProjectId = useNavigationStore((state) => state.activeProjectId);
  const navigateToSessions = useNavigationStore((state) => state.navigateToSessions);
  const activeSessionProjectId = useSessionStore((state) => {
    const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) ?? state.activeMainRepoSession;
    return activeSession?.projectId ?? null;
  });
  const setActiveSession = useSessionStore((state) => state.setActiveSession);

  const refresh = useCallback(async () => {
    const [configResponse, connectionResponse, hostResponse] = await Promise.all([
      API.remoteDaemon.getConfig(),
      API.remoteDaemon.getConnectionState(),
      API.remoteDaemon.getHostState(),
    ]);
    if (!configResponse.success || !configResponse.data) throw new Error(configResponse.error || 'Failed to load Remote Pane configuration');
    const nextConfig = configResponse.data;
    const previousHostConfig = configRef.current.host.config;
    setHostDraft((currentDraft) => (
      JSON.stringify(currentDraft) === JSON.stringify(previousHostConfig)
        ? nextConfig.host.config
        : currentDraft
    ));
    configRef.current = nextConfig;
    setConfig(nextConfig);
    setSetupListenPort((current) => current === 42137 ? configResponse.data!.host.config.listenPort : current);
    setSetupBaseline((current) => current.listenPort === 42137
      ? { ...current, listenPort: configResponse.data!.host.config.listenPort }
      : current);
    const baseUrl = formatRemoteBaseUrl(configResponse.data.host.config.listenHost, configResponse.data.host.config.listenPort);
    setPairBaseUrl((current) => current === 'http://127.0.0.1:42137' ? baseUrl : current);
    setProfileBaseUrl((current) => current === 'http://127.0.0.1:42137' ? baseUrl : current);
    if (connectionResponse.success && connectionResponse.data) setConnectionState(connectionResponse.data);
    if (hostResponse.success && hostResponse.data) setHostState(hostResponse.data);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await refresh();
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load Remote Pane');
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setResult(null);
    void reload();
    const unsubscribeConnection = window.electronAPI.remoteDaemon.onConnectionStateChanged(setConnectionState);
    const unsubscribeHost = window.electronAPI.remoteDaemon.onHostStateChanged(setHostState);
    return () => {
      unsubscribeConnection();
      unsubscribeHost();
    };
  }, [isOpen, reload]);

  const runRemoteRequest = useCallback(async <T,>(action: () => Promise<T>): Promise<RemoteActionOutcome<T>> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const value = await action();
      await Promise.all([refresh(), refreshConfigStore().catch(() => undefined)]);
      return { success: true, value };
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Remote Pane action failed');
      return { success: false };
    } finally {
      setBusy(false);
    }
  }, [refresh, refreshConfigStore]);

  const runRemoteAction = useCallback(async (action: () => Promise<string | void>) => {
    const outcome = await runRemoteRequest(action);
    if (outcome.success && outcome.value) setResult(outcome.value);
    return outcome.success;
  }, [runRemoteRequest]);

  const buildSetupRequest = (): RemoteHostSetupRequest => ({
    dataDirectoryMode: setupDataMode,
    label: setupLabel.trim(),
    listenPort: setupListenPort,
    paneDir: setupDataMode === 'isolated' && setupPaneDir.trim() ? setupPaneDir.trim() : undefined,
    preferTunnel: setupTunnelPreference,
    baseUrl: setupTunnelPreference === 'manual' ? setupManualBaseUrl.trim() || undefined : undefined,
    installService: setupDataMode === 'isolated' ? setupInstallService : false,
  });

  const getSetupDraft = (): RemoteHostSetupDraft => ({
    dataMode: setupDataMode,
    label: setupLabel,
    listenPort: setupListenPort,
    paneDir: setupPaneDir,
    tunnelPreference: setupTunnelPreference,
    manualBaseUrl: setupManualBaseUrl,
    installService: setupInstallService,
  });

  const setupHost = async () => {
    const outcome = await runRemoteRequest(async () => {
      const response = await API.remoteDaemon.setupHost(buildSetupRequest());
      if (!response.success || !response.data) throw new Error(response.error || 'Failed to set up this machine');
      return response.data;
    });
    if (!outcome.success) return false;
    setSetupResult(outcome.value);
    setSetupLabel('');
    setSetupListenPort(outcome.value.listenPort);
    setSetupBaseline({ ...getSetupDraft(), label: '', listenPort: outcome.value.listenPort });
    setResult('Remote host configured and connection code created.');
    return true;
  };

  const openSetupTerminal = async (client = false) => {
    const projectId = activeProjectId ?? activeSessionProjectId;
    if (!projectId) {
      setError('Select a project before opening a setup terminal.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const commandResponse = client
        ? await API.remoteDaemon.getInteractiveClientSetupCommand()
        : await API.remoteDaemon.getInteractiveSetupCommand(buildSetupRequest());
      if (!commandResponse.success || !commandResponse.data?.command) throw new Error(commandResponse.error || 'Failed to prepare setup command');
      const sessionResponse = await API.sessions.getOrCreateMainRepoSession(projectId);
      if (!sessionResponse.success || !sessionResponse.data?.id) throw new Error(sessionResponse.error || 'Failed to open project terminal');
      // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
      const sessionId = sessionResponse.data.id as string;
      const panel = await panelApi.createPanel({
        sessionId,
        type: 'terminal',
        title: client ? 'Tailscale Client Setup' : 'Tailscale Setup',
        initialState: { customState: { initialCommand: commandResponse.data.command } },
      });
      await panelApi.setActivePanel(sessionId, panel.id);
      await setActiveSession(sessionId);
      navigateToSessions();
      closeSettings();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Failed to open setup terminal');
    } finally {
      setBusy(false);
    }
  };

  const copyText = async (text: string, message: string) => {
    await navigator.clipboard.writeText(text);
    setResult(message);
  };

  const createHostCode = () => runRemoteAction(async () => {
    const response = await API.remoteDaemon.createHostConnectionCode({ label: setupLabel.trim() || undefined });
    if (!response.success || !response.data) throw new Error(response.error || 'Failed to create connection code');
    await navigator.clipboard.writeText(response.data.connectionCode);
    return 'Created and copied connection code.';
  });

  const stopHost = () => runRemoteAction(async () => {
    const response = await API.remoteDaemon.updateHostConfig({ enabled: false });
    if (!response.success) throw new Error(response.error || 'Failed to stop remote host');
    return 'Remote host stopped.';
  });

  const clearHostAccess = () => runRemoteAction(async () => {
    const response = await API.remoteDaemon.clearHostAccess();
    if (!response.success) throw new Error(response.error || 'Failed to forget host access');
    return 'Cached host code forgotten and existing remote clients revoked.';
  });

  const disconnectClients = (clientIds?: string[]) => runRemoteAction(async () => {
    const response = await API.remoteDaemon.disconnectHostClients(clientIds);
    if (!response.success) throw new Error(response.error || 'Failed to disconnect clients');
    return 'Remote clients disconnected.';
  });

  const revokeClient = (clientId: string) => runRemoteAction(async () => {
    const response = await API.remoteDaemon.deleteClientRecord(clientId);
    if (!response.success) throw new Error(response.error || 'Failed to revoke client');
    return 'Client access revoked.';
  });

  const importConnection = async () => {
    const outcome = await runRemoteRequest(async () => {
      const response = await API.remoteDaemon.importConnectionCode(connectionCode, { connect: true });
      if (!response.success || !response.data) throw new Error(response.error || 'Failed to import connection code');
      return response.data;
    });
    if (!outcome.success) return false;
    setConnectionCode('');
    setResult(outcome.value.connected
      ? `Connected to ${outcome.value.profile.label}.`
      : `Saved ${outcome.value.profile.label}${outcome.value.connectionError ? `, but connection failed: ${outcome.value.connectionError}` : '.'}`);
    return true;
  };

  const useProfile = (profileId: string) => runRemoteAction(async () => {
    const response = await API.remoteDaemon.updateClientState({ activeProfileId: profileId, mode: 'remote' });
    if (!response.success) throw new Error(response.error || 'Failed to connect to profile');
    return 'Remote runtime connected.';
  });

  const useLocal = () => runRemoteAction(async () => {
    const response = await API.remoteDaemon.updateClientState({ activeProfileId: null, mode: 'local' });
    if (!response.success) throw new Error(response.error || 'Failed to return to local runtime');
    return 'Using local runtime.';
  });

  const deleteProfile = (profileId: string) => runRemoteAction(async () => {
    const response = await API.remoteDaemon.deleteConnectionProfile(profileId);
    if (!response.success) throw new Error(response.error || 'Failed to delete profile');
    return 'Remote profile deleted.';
  });

  const saveHostConfig = () => runRemoteAction(async () => {
    const response = await API.remoteDaemon.updateHostConfig(hostDraft);
    if (!response.success) throw new Error(response.error || 'Failed to save host settings');
    return 'Host settings saved.';
  });

  const createPair = async () => {
    const outcome = await runRemoteRequest(async () => {
      const response = await API.remoteDaemon.createConnectionPair({ label: pairLabel.trim(), baseUrl: pairBaseUrl.trim() });
      if (!response.success || !response.data) throw new Error(response.error || 'Failed to create paired connection');
      return response.data;
    });
    if (!outcome.success) return false;
    setCreatedToken(outcome.value.token ?? null);
    setPairLabel('');
    setResult('Paired profile created.');
    return true;
  };

  const saveProfile = async () => {
    const profile: RemotePaneConnectionProfile = {
      id: crypto.randomUUID(),
      label: profileLabel.trim(),
      baseUrl: profileBaseUrl.trim(),
      token: profileToken.trim(),
      transport: 'http+sse',
    };
    const outcome = await runRemoteRequest(async () => {
      const response = await API.remoteDaemon.upsertConnectionProfile(profile);
      if (!response.success) throw new Error(response.error || 'Failed to save remote profile');
    });
    if (!outcome.success) return false;
    setProfileLabel('');
    setProfileToken('');
    setResult('Remote profile saved.');
    return true;
  };

  const validation = useMemo(() => ({
    setupPort: Number.isInteger(setupListenPort) && setupListenPort >= 1 && setupListenPort <= 65535,
    manualBaseUrl: setupTunnelPreference !== 'manual' || /^https:\/\//i.test(setupManualBaseUrl.trim()),
    hostPort: Number.isInteger(hostDraft.listenPort) && hostDraft.listenPort >= 1 && hostDraft.listenPort <= 65535,
    pair: pairLabel.trim().length > 0 && isValidHttpUrl(pairBaseUrl),
    profile: profileLabel.trim().length > 0 && isValidHttpUrl(profileBaseUrl) && profileToken.trim().length > 0,
  }), [hostDraft.listenPort, pairBaseUrl, pairLabel, profileBaseUrl, profileLabel, profileToken, setupListenPort, setupManualBaseUrl, setupTunnelPreference]);

  const setupDirty = JSON.stringify(getSetupDraft()) !== JSON.stringify(setupBaseline);

  const resetSubviewDraft = (subview: RemoteAccessSubviewId) => {
    if (subview === 'host-setup') {
      setSetupDataMode(setupBaseline.dataMode);
      setSetupLabel(setupBaseline.label);
      setSetupListenPort(setupBaseline.listenPort);
      setSetupPaneDir(setupBaseline.paneDir);
      setSetupTunnelPreference(setupBaseline.tunnelPreference);
      setSetupManualBaseUrl(setupBaseline.manualBaseUrl);
      setSetupInstallService(setupBaseline.installService);
      setSetupResult(null);
      return;
    }
    const baseUrl = formatRemoteBaseUrl(config.host.config.listenHost, config.host.config.listenPort);
    setHostDraft(config.host.config);
    setPairLabel('');
    setPairBaseUrl(baseUrl);
    setCreatedToken(null);
    setProfileLabel('');
    setProfileBaseUrl(baseUrl);
    setProfileToken('');
  };

  return {
    config,
    connectionState,
    hostState,
    hostDraft,
    setHostDraft,
    loading,
    busy,
    error,
    result,
    setupResult,
    setupDataMode,
    setSetupDataMode,
    setupLabel,
    setSetupLabel,
    setupListenPort,
    setSetupListenPort,
    setupPaneDir,
    setSetupPaneDir,
    setupTunnelPreference,
    setSetupTunnelPreference,
    setupManualBaseUrl,
    setSetupManualBaseUrl,
    setupInstallService,
    setSetupInstallService,
    setupDirty,
    connectionCode,
    setConnectionCode,
    pairLabel,
    setPairLabel,
    pairBaseUrl,
    setPairBaseUrl,
    createdToken,
    profileLabel,
    setProfileLabel,
    profileBaseUrl,
    setProfileBaseUrl,
    profileToken,
    setProfileToken,
    validation,
    refresh,
    reload,
    setupHost,
    openSetupTerminal,
    copyText,
    createHostCode,
    stopHost,
    clearHostAccess,
    disconnectClients,
    revokeClient,
    importConnection,
    useProfile,
    useLocal,
    deleteProfile,
    saveHostConfig,
    createPair,
    saveProfile,
    resetSubviewDraft,
  };
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export type RemoteAccessController = ReturnType<typeof useRemoteAccessSettings>;
