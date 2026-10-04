import { useEffect, useRef, useState, type RefObject } from 'react';
import { AlertTriangle, Check, Cloud, ExternalLink, Loader2, Plus, X } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal, ModalBody, ModalHeader } from '../ui/Modal';
import { Textarea } from '../ui/Textarea';
import { SettingsSection } from '../ui/SettingsSection';
import { ConfirmDialog } from '../ConfirmDialog';
import { SettingRow } from './SettingRow';
import { CloudSandboxSetupWarning } from './CloudSandboxSetupWarning';
import { SegmentedControl } from './SettingsControls';
import { API, type IPCResponse } from '../../utils/api';
import { useCloudSandboxes } from '../../hooks/useCloudSandboxes';
import { getActiveHostId, getHostTerminalPresentation, openHostTerminal } from '../../utils/hostTerminal';
import {
  formatCloudUptime,
  getCloudSandboxActions,
  getCloudGitHubNotice,
  getCloudLocalStartNotice,
  getCloudSandboxBadge,
  getCloudSandboxRows,
  getCloudStartupScriptNotice,
  getCloudStepLabel,
  STARTUP_SCRIPT_WARNING,
  type CloudSandboxRowAction,
} from '../../utils/cloudSandboxPresentation';
import { isWindows } from '../../utils/platformUtils';
import {
  getCloudSandboxNameError,
  type CloudCredentialStatus,
  type CloudLocalStartScript,
  type CloudLocalStartScriptShell,
  type CloudCredentialsUpdate,
  type CloudSandboxCreateRequest,
  type CloudSandboxesSnapshot,
  type CloudSandboxSize,
  type CloudSandboxView,
} from '../../../../shared/types/cloudSandboxes';

type SendCloudRequest = (send: () => Promise<IPCResponse<CloudSandboxesSnapshot>>) => Promise<boolean>;

const SIZE_OPTIONS: Array<{ id: CloudSandboxSize; label: string }> = [
  { id: 'small', label: 'Small' },
  { id: 'default', label: 'Default' },
  { id: 'large', label: 'Large' },
];

const ACTION_LABELS = new Map<CloudSandboxRowAction, string>([
  ['retry', 'Retry'],
  ['dismiss', 'Dismiss'],
  ['start', 'Start'],
  ['terminal', 'Open terminal'],
  ['stop', 'Stop'],
  ['update', 'Update Pane'],
  ['startup-script', 'Startup script'],
  ['remove', 'Remove'],
]);

/** Cloud sandboxes (experimental): Pane on a provider sandbox, joined to the user's tailnet. */
export function CloudSandboxesSettings({ onTerminalOpened }: { onTerminalOpened: () => void }) {
  const { snapshot, loaded, request } = useCloudSandboxes();
  const [requestError, setRequestError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CloudSandboxView | null>(null);
  const [viewingLog, setViewingLog] = useState<CloudSandboxView | null>(null);
  const startupScriptRef = useRef<HTMLTextAreaElement>(null);
  const now = useMinuteClock();

  const send: SendCloudRequest = async (call) => {
    setRequestError(null);
    const result = await request(call);
    if (!result.ok) setRequestError(result.error);
    return result.ok;
  };

  // The same terminal as the host switcher's: switch this window to the sandbox first if needed.
  const openTerminal = async (profileId: string) => {
    setRequestError(null);
    try {
      if (await getActiveHostId() !== profileId) {
        const response = await API.remoteDaemon.updateClientState({ activeProfileId: profileId, mode: 'remote' });
        if (!response.success) throw new Error(response.error ?? 'Could not connect to the sandbox');
      }
      await openHostTerminal();
      onTerminalOpened();
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    }
  };

  const runAction = (sandbox: CloudSandboxView, action: CloudSandboxRowAction) => {
    if (action === 'remove') {
      setRemoving(sandbox);
      return;
    }
    if (action === 'terminal') {
      if (sandbox.profileId) void openTerminal(sandbox.profileId);
      return;
    }
    if (action === 'startup-script') {
      startupScriptRef.current?.scrollIntoView({ block: 'center' });
      startupScriptRef.current?.focus();
      return;
    }
    void send(() => {
      if (action === 'retry') return API.remoteDaemon.retryCloudSandbox(sandbox.id);
      if (action === 'dismiss') return API.remoteDaemon.dismissCloudSandbox(sandbox.id);
      if (action === 'start') return API.remoteDaemon.startCloudSandbox(sandbox.id);
      if (action === 'update') return API.remoteDaemon.updateCloudSandbox(sandbox.id);
      return API.remoteDaemon.stopCloudSandbox(sandbox.id);
    });
  };

  const canCreate = snapshot.credentials.boat && snapshot.credentials.tailscale;

  return (
    <SettingsSection
      title="Cloud sandboxes (experimental)"
      description="Run Pane on a boat.dev sandbox in your tailnet. Stop snapshots it so it costs nothing while stopped; Start resumes it."
    >
      {!loaded && <p className="py-3 text-sm text-text-tertiary" aria-live="polite">Loading cloud sandboxes...</p>}
      {loaded && !snapshot.available && (
        <p className="py-3 text-sm text-text-tertiary">Cloud sandboxes are not available in this build of Pane.</p>
      )}
      {loaded && snapshot.available && (
        <>
          {snapshot.loadError && (
            <div className="my-2 flex items-center justify-between gap-3 rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-status-error" role="alert">
              <span>{snapshot.loadError}</span>
              <Button type="button" variant="secondary" size="sm" onClick={() => void send(() => API.remoteDaemon.getCloudSandboxes())}>Retry</Button>
            </div>
          )}
          <CloudCredentialsRow credentials={snapshot.credentials} send={send} />
          <GitHubTokenRow saved={snapshot.credentials.github} send={send} />
          <SettingRow
            settingId="remote-cloud-sandboxes"
            label="Add cloud sandbox"
            description={canCreate ? 'Each sandbox shows up in the host switcher like any other remote host.' : 'Save the boat API key and Tailscale OAuth client first.'}
            align="start"
          >
            <CloudSandboxSetupWarning githubTokenSet={snapshot.credentials.github} localStartScriptSet={snapshot.localStartScriptSet} />
            <AddCloudSandboxForm
              disabled={!canCreate}
              takenNames={snapshot.sandboxes.map((sandbox) => sandbox.label)}
              onCreate={(createRequest) => void send(() => API.remoteDaemon.createCloudSandbox(createRequest))}
            />
          </SettingRow>
          <LocalStartScriptRow send={send} />
          <StartupScriptRow textareaRef={startupScriptRef} send={send} />
          {snapshot.sandboxes.length > 0 && (
            <ul className="divide-y divide-border-secondary" aria-label="Cloud sandboxes">
              {getCloudSandboxRows(snapshot.sandboxes).map((sandbox) => (
                <CloudSandboxRow key={sandbox.id} sandbox={sandbox} now={now} onAction={runAction} onViewLog={setViewingLog} />
              ))}
            </ul>
          )}
        </>
      )}
      {requestError && (
        <div className="my-2 rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-status-error" role="alert">{requestError}</div>
      )}
      <ConfirmDialog
        isOpen={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void send(() => API.remoteDaemon.removeCloudSandbox(removing.id));
        }}
        title={`Remove ${removing?.label ?? 'cloud sandbox'}?`}
        message="This destroys the sandbox and its tailnet device and forgets the saved host. Anything on it that you haven't pushed is lost."
        confirmText="Remove"
      />
      {viewingLog && <StartupLogDialog sandbox={viewingLog} onClose={() => setViewingLog(null)} />}
    </SettingsSection>
  );
}

/** The current time, ticking each minute, for "running for" hints. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function CloudCredentialsRow({ credentials, send }: { credentials: CloudCredentialStatus; send: SendCloudRequest }) {
  const [editing, setEditing] = useState(false);
  const [boatApiKey, setBoatApiKey] = useState('');
  const [boatOrg, setBoatOrg] = useState('');
  const [tailscaleClientId, setTailscaleClientId] = useState('');
  const [tailscaleClientSecret, setTailscaleClientSecret] = useState('');
  const [claudeToken, setClaudeToken] = useState('');
  const [saving, setSaving] = useState(false);

  const missingRequired = !credentials.boat || !credentials.tailscale;
  const formOpen = editing || missingRequired;
  const tailscaleIncomplete = Boolean(tailscaleClientId.trim()) !== Boolean(tailscaleClientSecret.trim());
  const update: CloudCredentialsUpdate = {};
  if (boatApiKey.trim()) update.boatApiKey = boatApiKey.trim();
  if (boatOrg.trim()) update.boatOrg = boatOrg.trim();
  if (tailscaleClientId.trim() && tailscaleClientSecret.trim()) {
    update.tailscale = { clientId: tailscaleClientId.trim(), clientSecret: tailscaleClientSecret.trim() };
  }
  if (claudeToken.trim()) update.claudeToken = claudeToken.trim();
  const hasUpdate = Object.keys(update).length > 0;

  const clear = () => {
    setBoatApiKey('');
    setBoatOrg('');
    setTailscaleClientId('');
    setTailscaleClientSecret('');
    setClaudeToken('');
  };

  const save = async () => {
    setSaving(true);
    let saved = false;
    try {
      saved = await send(() => API.remoteDaemon.updateCloudCredentials(update));
    } finally {
      setSaving(false);
    }
    if (!saved) return;
    clear();
    setEditing(false);
  };

  return (
    <SettingRow
      settingId="remote-cloud-credentials"
      label="Credentials"
      description="Entered once and kept on this computer. Pane never shows them again."
      align="start"
    >
      <div className="w-full space-y-3 sm:w-[460px]">
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm" aria-label="Saved cloud credentials">
          <CredentialStatus label="boat API key" set={credentials.boat} />
          <dt className="text-text-secondary">boat wallet</dt>
          <dd className="text-right text-text-primary">{credentials.boatOrg ?? 'Account default'}</dd>
          <CredentialStatus label="Tailscale OAuth client" set={credentials.tailscale} />
          <CredentialStatus label="Claude token (optional)" set={credentials.claude} />
        </dl>
        {formOpen ? (
          <div className="ph-no-capture space-y-3">
            <Input label="boat API key" type="password" autoComplete="off" value={boatApiKey} onChange={(event) => setBoatApiKey(event.target.value)} placeholder={credentials.boat ? 'Leave blank to keep the saved key' : undefined} fullWidth />
            <Input label="boat wallet" autoComplete="off" value={boatOrg} onChange={(event) => setBoatOrg(event.target.value)} placeholder={credentials.boatOrg ?? 'personal'} helperText="The wallet new sandboxes bill: a team name or id, or personal." fullWidth />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Tailscale OAuth client ID" type="password" autoComplete="off" value={tailscaleClientId} onChange={(event) => setTailscaleClientId(event.target.value)} fullWidth />
              <Input
                label="Tailscale OAuth client secret"
                type="password"
                autoComplete="off"
                value={tailscaleClientSecret}
                onChange={(event) => setTailscaleClientSecret(event.target.value)}
                error={tailscaleIncomplete ? 'Enter both the client ID and secret' : undefined}
                fullWidth
              />
            </div>
            <Input label="Claude token" type="password" autoComplete="off" value={claudeToken} onChange={(event) => setClaudeToken(event.target.value)} helperText="From claude setup-token. Without it, sign in to Claude on the sandbox yourself." fullWidth />
            <div className="flex justify-end gap-2">
              {!missingRequired && (
                <Button type="button" variant="ghost" size="sm" onClick={() => { clear(); setEditing(false); }}>Cancel</Button>
              )}
              <Button type="button" size="sm" loading={saving} disabled={!hasUpdate || tailscaleIncomplete} onClick={() => void save()}>Save Credentials</Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>Change Credentials</Button>
          </div>
        )}
      </div>
    </SettingRow>
  );
}

/** One startup script for every sandbox, kept on this computer; saving runs it on the running ones. */
function StartupScriptRow({ textareaRef, send }: { textareaRef: RefObject<HTMLTextAreaElement | null>; send: SendCloudRequest }) {
  const [script, setScript] = useState('');
  const [savedScript, setSavedScript] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void API.remoteDaemon.getCloudStartupScript().then((response) => {
      if (cancelled) return;
      if (!response.success || !response.data) {
        setLoadError(response.error || 'Could not read the startup script');
        return;
      }
      setScript(response.data.script);
      setSavedScript(response.data.script);
    }).catch((error) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Could not read the startup script');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      if (await send(() => API.remoteDaemon.saveCloudStartupScript(script))) setSavedScript(script);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      settingId="remote-cloud-startup-script"
      label="Startup script"
      description="One script for every sandbox. It runs each time a sandbox starts, so make it safe to run again: guard installs with command -v tool || install."
      align="start"
    >
      <div className="w-full space-y-3 sm:w-[460px]">
        <p className="flex items-center gap-2 text-sm text-status-warning">
          <AlertTriangle className="h-4 w-4 flex-none" aria-hidden="true" />
          {STARTUP_SCRIPT_WARNING}
        </p>
        <Textarea
          ref={textareaRef}
          aria-label="Startup script"
          className="font-mono text-xs"
          rows={8}
          spellCheck={false}
          value={script}
          onChange={(event) => setScript(event.target.value)}
          placeholder={'command -v doppler >/dev/null || curl -Ls https://cli.doppler.com/install.sh | sudo sh'}
          disabled={savedScript === null && !loadError}
          error={loadError}
          fullWidth
        />
        <div className="flex items-center justify-end gap-2">
          {savedScript !== null && script === savedScript && <span className="text-xs text-text-tertiary" role="status">Saved</span>}
          <Button type="button" size="sm" loading={saving} disabled={savedScript === null || script === savedScript} onClick={() => void save()}>
            Save Startup Script
          </Button>
        </div>
      </div>
    </SettingRow>
  );
}

const LOCAL_SHELL_OPTIONS: Array<{ id: CloudLocalStartScriptShell; label: string }> = [
  { id: 'powershell', label: 'PowerShell' },
  { id: 'cmd', label: 'cmd' },
];

/**
 * The local start script: it runs on THIS computer before each sandbox is created or started, and the KEY=VALUE lines
 * it prints become variables on that one sandbox. Saving runs nothing and sends nothing.
 */
function LocalStartScriptRow({ send }: { send: SendCloudRequest }) {
  const windows = isWindows();
  const [shell, setShell] = useState<CloudLocalStartScriptShell>(windows ? 'powershell' : 'sh');
  const [script, setScript] = useState('');
  const [saved, setSaved] = useState<CloudLocalStartScript | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void API.remoteDaemon.getCloudLocalStartScript().then((response) => {
      if (cancelled) return;
      if (!response.success || !response.data) {
        setLoadError(response.error || 'Could not read the local start script');
        return;
      }
      setShell(response.data.shell);
      setScript(response.data.script);
      setSaved(response.data);
    }).catch((error) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Could not read the local start script');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const unchanged = saved !== null && saved.script === script && saved.shell === shell;
  const save = async () => {
    setSaving(true);
    try {
      if (await send(() => API.remoteDaemon.saveCloudLocalStartScript({ shell, script }))) setSaved({ shell, script });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      settingId="remote-cloud-local-start-script"
      label="Local start script"
      description="Runs on this computer each time a sandbox is created or started. Every KEY=VALUE line it prints becomes a variable on that sandbox only, in its terminals, its agents' shells and its startup script."
      align="start"
    >
      <div className="w-full space-y-3 sm:w-[460px]">
        <p className="flex items-center gap-2 text-sm text-status-warning">
          <AlertTriangle className="h-4 w-4 flex-none" aria-hidden="true" />
          Fetch secrets here, don't paste them: the script is stored unencrypted.
        </p>
        {windows && <SegmentedControl label="Shell" columns={2} value={shell === 'sh' ? 'powershell' : shell} options={LOCAL_SHELL_OPTIONS} onChange={setShell} />}
        <Textarea
          aria-label="Local start script"
          className="font-mono text-xs"
          rows={5}
          spellCheck={false}
          value={script}
          onChange={(event) => setScript(event.target.value)}
          placeholder={shell === 'sh' ? 'echo "DOPPLER_TOKEN=$(doppler configure get token --plain)"' : shell === 'cmd' ? 'for /f %t in (\'doppler configure get token --plain\') do @echo DOPPLER_TOKEN=%t' : '"DOPPLER_TOKEN=$(doppler configure get token --plain)"'}
          disabled={saved === null && !loadError}
          error={loadError}
          helperText="Stopped after 60 s. Values are never shown or logged; names like PATH, HOME or GITHUB_TOKEN are skipped."
          fullWidth
        />
        <div className="flex items-center justify-end gap-2">
          {unchanged && <span className="text-xs text-text-tertiary" role="status">Saved</span>}
          <Button type="button" size="sm" loading={saving} disabled={saved === null || unchanged} onClick={() => void save()}>
            Save Local Start Script
          </Button>
        </div>
      </div>
    </SettingRow>
  );
}

/** The last 200 lines of a sandbox's startup log, read when the dialog opens. */
function StartupLogDialog({ sandbox, onClose }: { sandbox: CloudSandboxView; onClose: () => void }) {
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void API.remoteDaemon.readCloudSandboxStartupLog(sandbox.id).then((response) => {
      if (cancelled) return;
      if (response.success && response.data) setLog(response.data.log);
      else setError(response.error || 'Could not read the startup log');
    }).catch((readError) => {
      if (!cancelled) setError(readError instanceof Error ? readError.message : 'Could not read the startup log');
    });
    return () => {
      cancelled = true;
    };
  }, [sandbox.id]);

  const title = `Startup log: ${sandbox.label}`;
  return (
    <Modal isOpen onClose={onClose} size="lg" ariaLabel={title}>
      <ModalHeader title={title} description="The last 200 lines of the latest run." />
      <ModalBody>
        {error && <p className="text-sm text-status-error" role="alert">{error}</p>}
        {!error && log === null && <p className="text-sm text-text-tertiary" aria-live="polite">Loading the log...</p>}
        {log !== null && (
          <pre className="ph-no-capture max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-surface-secondary p-3 font-mono text-xs text-text-primary">
            {log || 'The log is empty.'}
          </pre>
        )}
      </ModalBody>
    </Modal>
  );
}

/** Where to create a fine-grained token, and what it needs. */
const GITHUB_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

/** The GitHub token every sandbox signs gh and git in with, kept like the other credentials (only Set / Not set). */
function GitHubTokenRow({ saved, send }: { saved: boolean; send: SendCloudRequest }) {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      if (await send(() => API.remoteDaemon.updateCloudCredentials({ githubToken: token.trim() }))) setToken('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      settingId="remote-cloud-github-token"
      label="GitHub token"
      description="Every sandbox signs gh and git in with it when it is created and each time it starts, so cloning and pushing need no sign-in."
      align="start"
    >
      <div className="ph-no-capture w-full space-y-3 sm:w-[460px]">
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 text-sm" aria-label="Saved GitHub token">
          <CredentialStatus label="Saved token" set={saved} />
        </dl>
        <Input
          label="GitHub token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={saved ? 'Leave blank to keep the saved token' : undefined}
          helperText="A fine-grained personal access token with Contents and Pull requests set to Read and write, for the repositories your agents work on."
          fullWidth
        />
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={<ExternalLink className="h-4 w-4" />}
            onClick={() => void window.electronAPI?.openExternal(GITHUB_TOKEN_URL)}
          >
            Create a fine-grained token
          </Button>
          <Button type="button" size="sm" loading={saving} disabled={!token.trim()} onClick={() => void save()}>
            Save GitHub Token
          </Button>
        </div>
      </div>
    </SettingRow>
  );
}

function CredentialStatus({ label, set }: { label: string; set: boolean }) {
  return (
    <>
      <dt className="text-text-secondary">{label}</dt>
      <dd className="justify-self-end">
        <Badge size="sm" variant={set ? 'success' : 'default'}>{set ? 'Set' : 'Not set'}</Badge>
      </dd>
    </>
  );
}

function AddCloudSandboxForm({ disabled, takenNames, onCreate }: {
  disabled: boolean;
  takenNames: string[];
  onCreate: (request: CloudSandboxCreateRequest) => void;
}) {
  const [name, setName] = useState('');
  const [size, setSize] = useState<CloudSandboxSize>('default');
  const trimmedName = name.trim();
  const nameError = takenNames.includes(trimmedName) ? 'A cloud sandbox has this name' : getCloudSandboxNameError(trimmedName);

  const create = () => {
    onCreate({ name: trimmedName, size });
    setName('');
  };

  return (
    <div className="w-full space-y-3 sm:w-[460px]">
      <Input
        label="Name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="api-refactor"
        error={trimmedName && nameError ? nameError : undefined}
        disabled={disabled}
        fullWidth
      />
      <SegmentedControl label="Sandbox size" columns={3} value={size} options={SIZE_OPTIONS} onChange={setSize} />
      <div className="flex justify-end">
        <Button type="button" size="sm" icon={<Plus className="h-4 w-4" />} disabled={disabled || nameError !== null} onClick={create}>
          Add Cloud Sandbox
        </Button>
      </div>
    </div>
  );
}

function CloudSandboxRow({ sandbox, now, onAction, onViewLog }: {
  sandbox: CloudSandboxView;
  now: number;
  onAction: (sandbox: CloudSandboxView, action: CloudSandboxRowAction) => void;
  onViewLog: (sandbox: CloudSandboxView) => void;
}) {
  const badge = getCloudSandboxBadge(sandbox);
  const startupNotice = getCloudStartupScriptNotice(sandbox);
  const githubNotice = getCloudGitHubNotice(sandbox);
  const localStartNotice = getCloudLocalStartNotice(sandbox);
  const details = [
    sandbox.hostname,
    sandbox.size,
    sandbox.state === 'running' && !sandbox.pending ? formatCloudUptime(sandbox.startedAt, now) : null,
    sandbox.daemonVersion ? `Pane ${sandbox.daemonVersion}${sandbox.updateAvailable ? ' (differs from this app)' : ''}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <li className="space-y-2 py-3" aria-label={`Cloud sandbox ${sandbox.label}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Cloud className="h-4 w-4 flex-none text-text-tertiary" />
            <span className="truncate">{sandbox.label}</span>
            <Badge size="sm" variant={badge.variant}>{badge.label}</Badge>
          </p>
          {details && <p className="mt-1 truncate text-xs text-text-tertiary">{details}</p>}
          {sandbox.progress && (
            <p className="mt-1 truncate text-xs text-text-secondary" role="status">{sandbox.progress}</p>
          )}
        </div>
        <div className="flex flex-none flex-wrap justify-end gap-1">
          {sandbox.pending && <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" aria-hidden="true" />}
          {getCloudSandboxActions(sandbox).map((action) => (
            <Button
              key={action}
              type="button"
              size="sm"
              variant={action === 'remove' ? 'ghost' : action === 'update' || action === 'retry' ? 'primary' : 'secondary'}
              aria-label={action === 'terminal'
                ? getHostTerminalPresentation({ label: sandbox.label }).openLabel
                : `${ACTION_LABELS.get(action)} ${sandbox.label}`}
              onClick={() => onAction(sandbox, action)}
            >
              {ACTION_LABELS.get(action)}
            </Button>
          ))}
        </div>
      </div>
      {sandbox.steps && sandbox.steps.length > 0 && (
        <div role="status" aria-label={`Progress for ${sandbox.label}`}>
          <ol className="space-y-1 pl-6 text-xs">
            {sandbox.steps.map((step) => (
              <li key={step.step} className="flex items-center gap-2 text-text-secondary">
                {step.state === 'done'
                  ? <Check className="h-3.5 w-3.5 text-status-success" aria-hidden="true" />
                  : sandbox.state === 'creating'
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    : <X className="h-3.5 w-3.5 text-status-error" aria-hidden="true" />}
                <span>{step.message ?? getCloudStepLabel(step.step)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {sandbox.error && (
        <p className="rounded-md border border-status-error/30 bg-status-error/10 p-2 text-xs text-status-error" role="alert">{sandbox.error}</p>
      )}
      {githubNotice && (
        <p
          className={githubNotice.kind === 'ok' ? 'text-xs text-text-secondary' : 'text-xs text-status-warning'}
          role={githubNotice.kind === 'ok' ? 'status' : 'alert'}
        >
          {githubNotice.text}
        </p>
      )}
      {localStartNotice && (
        <p
          className={localStartNotice.kind === 'info' ? 'text-xs text-text-secondary' : 'text-xs text-status-warning'}
          role={localStartNotice.kind === 'info' ? 'status' : 'alert'}
        >
          {localStartNotice.text}
        </p>
      )}
      {startupNotice?.kind === 'running' && (
        <p className="flex items-center gap-2 text-xs text-text-secondary" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {startupNotice.text}
        </p>
      )}
      {startupNotice?.kind === 'failed' && (
        <p className="flex flex-wrap items-center gap-x-1 rounded-md border border-status-warning/30 bg-status-warning/10 p-2 text-xs text-status-warning" role="alert">
          <span>{startupNotice.text}</span>
          {startupNotice.viewLog && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="underline hover:text-text-primary"
                aria-label={`View log for ${sandbox.label}`}
                onClick={() => onViewLog(sandbox)}
              >
                View log
              </button>
            </>
          )}
        </p>
      )}
    </li>
  );
}
