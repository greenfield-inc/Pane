import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_REMOTE_DAEMON_HOST_CONFIG,
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
import { DEFAULT_REMOTE_BASE_URL, formatRemoteBaseUrl } from '../../utils/remote-base-url';
import { API } from '../../utils/api';
import { panelApi } from '../../services/panelApi';
import { useConfigStore } from '../../stores/configStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useSessionStore } from '../../stores/sessionStore';

interface RemoteHostSetupValues {
  dataMode: RemoteSetupDataDirectoryMode;
  label: string;
  listenPort: number;
  paneDir: string;
  tunnelPreference: RemoteSetupTunnelPreference;
  manualBaseUrl: string;
  installService: boolean;
}

interface RemoteHostSetupDraft {
  values: RemoteHostSetupValues;
  touched: Partial<Record<keyof RemoteHostSetupValues, true>>;
}

type RemoteActionOutcome<T> =
  | { success: true; value: T }
  | { success: false };

const DEFAULT_HOST_SETUP_DRAFT: RemoteHostSetupValues = {
  dataMode: 'current',
  label: '',
  listenPort: DEFAULT_REMOTE_DAEMON_HOST_CONFIG.listenPort,
  paneDir: '',
  tunnelPreference: 'tailscale',
  manualBaseUrl: '',
  installService: true,
};

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

  const [setupDraft, setSetupDraft] = useState<RemoteHostSetupDraft>({ values: DEFAULT_HOST_SETUP_DRAFT, touched: {} });
  const [setupBaseline, setSetupBaseline] = useState(DEFAULT_HOST_SETUP_DRAFT);
  const { dataMode: setupDataMode, label: setupLabel, listenPort: setupListenPort, paneDir: setupPaneDir,
    tunnelPreference: setupTunnelPreference, manualBaseUrl: setupManualBaseUrl, installService: setupInstallService } = setupDraft.values;
  const updateSetupField = <Key extends keyof RemoteHostSetupValues>(key: Key, value: RemoteHostSetupValues[Key]) => {
    setSetupDraft(current => ({ values: { ...current.values, [key]: value }, touched: { ...current.touched, [key]: true } }));
  };

  const [connectionCode, setConnectionCode] = useState('');
  const [pairLabel, setPairLabel] = useState('');
  const [pairUrlDraft, setPairUrlDraft] = useState({ value: DEFAULT_REMOTE_BASE_URL, touched: false });
  const pairBaseUrl = pairUrlDraft.value;
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [profileLabel, setProfileLabel] = useState('');
  const [profileUrlDraft, setProfileUrlDraft] = useState({ value: DEFAULT_REMOTE_BASE_URL, touched: false });
  const profileBaseUrl = profileUrlDraft.value;
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
    const { listenHost, listenPort } = nextConfig.host.config;
    setSetupDraft(current => current.touched.listenPort ? current : { ...current, values: { ...current.values, listenPort } });
    setSetupBaseline(current => ({ ...current, listenPort }));
    const baseUrl = formatRemoteBaseUrl(listenHost, listenPort);
    setPairUrlDraft(current => current.touched ? current : { value: baseUrl, touched: false });
    setProfileUrlDraft(current => current.touched ? current : { value: baseUrl, touched: false });
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

  const setupHost = async () => {
    const outcome = await runRemoteRequest(async () => {
      const response = await API.remoteDaemon.setupHost(buildSetupRequest());
      if (!response.success || !response.data) throw new Error(response.error || 'Failed to set up this machine');
      return response.data;
    });
    if (!outcome.success) return false;
    setSetupResult(outcome.value);
    const nextDraft = { ...setupDraft.values, label: '', listenPort: outcome.value.listenPort };
    setSetupDraft({ values: nextDraft, touched: {} });
    setSetupBaseline(nextDraft);
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

  const setupDirty = JSON.stringify(setupDraft.values) !== JSON.stringify(setupBaseline);

  const configuredBaseUrl = formatRemoteBaseUrl(config.host.config.listenHost, config.host.config.listenPort);
  const advancedDirty = JSON.stringify(hostDraft) !== JSON.stringify(config.host.config)
    || Boolean(pairLabel || profileLabel || profileToken)
    || (pairUrlDraft.touched && pairBaseUrl !== configuredBaseUrl)
    || (profileUrlDraft.touched && profileBaseUrl !== configuredBaseUrl);

  const resetSubviewDraft = (subview: 'host-setup' | 'connections' | 'advanced-host') => {
    if (subview === 'host-setup') {
      setSetupDraft({ values: setupBaseline, touched: {} });
      setSetupResult(null);
      return;
    }
    if (subview === 'connections') {
      setConnectionCode('');
      return;
    }
    const baseUrl = formatRemoteBaseUrl(config.host.config.listenHost, config.host.config.listenPort);
    setHostDraft(config.host.config);
    setPairLabel('');
    setPairUrlDraft({ value: baseUrl, touched: false });
    setCreatedToken(null);
    setProfileLabel('');
    setProfileUrlDraft({ value: baseUrl, touched: false });
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
    setSetupDataMode: (value: RemoteSetupDataDirectoryMode) => updateSetupField('dataMode', value),
    setupLabel,
    setSetupLabel: (value: string) => updateSetupField('label', value),
    setupListenPort,
    setSetupListenPort: (value: number) => updateSetupField('listenPort', value),
    setupPaneDir,
    setSetupPaneDir: (value: string) => updateSetupField('paneDir', value),
    setupTunnelPreference,
    setSetupTunnelPreference: (value: RemoteSetupTunnelPreference) => updateSetupField('tunnelPreference', value),
    setupManualBaseUrl,
    setSetupManualBaseUrl: (value: string) => updateSetupField('manualBaseUrl', value),
    setupInstallService,
    setSetupInstallService: (value: boolean) => updateSetupField('installService', value),
    setupDirty,
    advancedDirty,
    connectionCode,
    setConnectionCode,
    pairLabel,
    setPairLabel,
    pairBaseUrl,
    setPairBaseUrl: (value: string) => setPairUrlDraft({ value, touched: true }),
    createdToken,
    profileLabel,
    setProfileLabel,
    profileBaseUrl,
    setProfileBaseUrl: (value: string) => setProfileUrlDraft({ value, touched: true }),
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
