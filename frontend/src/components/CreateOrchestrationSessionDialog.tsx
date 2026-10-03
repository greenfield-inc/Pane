import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import type { CustomCommandResume } from '../../../shared/types/customCommandResume';
import { DEFAULT_PANE_CHAT_AGENT, PANE_CHAT_AGENT_LABELS, type PaneChatAgent } from '../../../shared/types/paneChat';
import { DEFAULT_SESSION_PROFILE } from '../../../shared/types/sessionProfile';
import type { AppConfig } from '../types/config';
import { useConfigStore } from '../stores/configStore';
import { visibleAgentPresets } from '../utils/agentPresets';
import { cn } from '../utils/cn';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { SessionLaunchFields } from './SessionLaunchFields';

const SESSION_AGENT_OPTIONS: ReadonlyArray<{ id: PaneChatAgent; label: string }> = (['claude', 'codex', 'cursor'] as const)
  .map(id => ({ id, label: PANE_CHAT_AGENT_LABELS[id] }));

function availableSessionAgents(wsl = false): ReadonlyArray<{ id: PaneChatAgent; label: string }> {
  if (wsl) return SESSION_AGENT_OPTIONS;
  const visible = new Set(visibleAgentPresets().map(preset => preset.id));
  return SESSION_AGENT_OPTIONS.filter(option => visible.has(option.id));
}

function supportedSessionAgent(preferred?: PaneChatAgent): PaneChatAgent {
  const options = availableSessionAgents();
  if (preferred && options.some(option => option.id === preferred)) return preferred;
  return options[0]?.id ?? DEFAULT_PANE_CHAT_AGENT;
}

interface CreateOrchestrationSessionDialogProps {
  onSubmittingChange?: (submitting: boolean) => void;
  header?: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  onCreate: (agent: PaneChatAgent, name?: string, launchCommand?: string, profile?: string, customResume?: CustomCommandResume | null, wslDistribution?: string) => Promise<void>;
}

interface SessionCreationForm {
  agent: PaneChatAgent;
  name: string;
  launchCommand: string;
  customResume: CustomCommandResume | null;
  profile: string;
  error: string | null;
}

type SessionCreationAction =
  | { type: 'reset'; config: AppConfig | null }
  | { type: 'update'; values: Partial<SessionCreationForm> };

function initialSessionCreationForm(config: AppConfig | null): SessionCreationForm {
  return {
    agent: supportedSessionAgent(config?.defaultOrchestratorAgent),
    name: '',
    launchCommand: config?.defaultSessionCommand ?? '',
    customResume: config?.defaultSessionResume ?? null,
    profile: config?.defaultSessionProfile ?? DEFAULT_SESSION_PROFILE,
    error: null,
  };
}

function sessionCreationReducer(state: SessionCreationForm, action: SessionCreationAction): SessionCreationForm {
  return action.type === 'reset' ? initialSessionCreationForm(action.config) : { ...state, ...action.values };
}

export function CreateOrchestrationSessionDialog(props: CreateOrchestrationSessionDialogProps) {
  return <Modal isOpen={props.isOpen} onClose={props.onClose} size="md" ariaLabel="Create Session">
    <OrchestrationSessionForm {...props} />
  </Modal>;
}

export function OrchestrationSessionForm({ isOpen, onClose, onCreate, header, onSubmittingChange }: CreateOrchestrationSessionDialogProps) {
  const [distributions, setDistributions] = useState<string[]>([]);
  const [wslDistribution, setWslDistribution] = useState('');
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setWslDistribution('');
    setDistributions([]);
    void window.electronAPI?.orchestrationSessions?.runtimes?.().then(result => {
      if (!cancelled && result.success) setDistributions(result.data?.distributions ?? []);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [isOpen]);
  const [{ agent, name, launchCommand, customResume, profile, error }, dispatch] = useReducer(sessionCreationReducer, null, initialSessionCreationForm);
  const userEditedLaunch = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const config = useConfigStore(state => state.config);
  const fetchConfig = useConfigStore(state => state.fetchConfig);
  const updateConfig = useConfigStore(state => state.updateConfig);
  const userSelectedAgent = useRef(false);

  useEffect(() => {
    if (!isOpen || userSelectedAgent.current) return;
    dispatch({ type: 'update', values: { agent: wslDistribution
      ? config?.defaultOrchestratorAgent ?? DEFAULT_PANE_CHAT_AGENT
      : supportedSessionAgent(config?.defaultOrchestratorAgent) } });
  }, [isOpen, wslDistribution, config?.defaultOrchestratorAgent]);

  useEffect(() => {
    if (!isOpen) return;
    userSelectedAgent.current = false;
    userEditedLaunch.current = false;
    const savedConfig = useConfigStore.getState().config;
    dispatch({ type: 'reset', config: savedConfig });
    if (!savedConfig) {
      void fetchConfig().then(nextConfig => {
        if (!userSelectedAgent.current) dispatch({ type: 'update', values: { agent: supportedSessionAgent(nextConfig.defaultOrchestratorAgent) } });
        if (!userEditedLaunch.current) {
          dispatch({ type: 'update', values: {
            launchCommand: nextConfig.defaultSessionCommand ?? '',
            customResume: nextConfig.defaultSessionResume ?? null,
            profile: nextConfig.defaultSessionProfile ?? DEFAULT_SESSION_PROFILE,
          } });
        }
      }).catch(() => undefined);
    }
  }, [fetchConfig, isOpen]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    onSubmittingChange?.(true);
    dispatch({ type: 'update', values: { error: null } });
    try {
      const defaults: Partial<AppConfig> = {};
      if (config?.defaultOrchestratorAgent !== agent) defaults.defaultOrchestratorAgent = agent;
      if ((config?.defaultSessionCommand ?? '') !== launchCommand) defaults.defaultSessionCommand = launchCommand;
      if (JSON.stringify(config?.defaultSessionResume ?? null) !== JSON.stringify(customResume)) defaults.defaultSessionResume = customResume;
      if (Object.keys(defaults).length > 0) await updateConfig(defaults);
      await onCreate(agent, name.trim() || undefined, launchCommand, profile, customResume, wslDistribution || undefined);
    } catch (cause) {
      dispatch({ type: 'update', values: { error: cause instanceof Error ? cause.message : 'Failed to create Session' } });
    } finally {
      setIsSubmitting(false);
      onSubmittingChange?.(false);
    }
  };

  return (
      <form onSubmit={submit} className="flex min-h-0 flex-col">
        {header ?? <ModalHeader title="Create Session" />}
        <ModalBody className="min-h-0 space-y-4">
          <Input label="Name your chat (optional)" value={name} onChange={event => dispatch({ type: 'update', values: { name: event.target.value } })} placeholder="New chat" autoFocus fullWidth />
          <fieldset className="space-y-2">
            <legend className="text-label font-medium text-text-primary">Choose an agent</legend>
            <div className="grid gap-2" role="radiogroup" aria-label="Session agent">
              {availableSessionAgents(Boolean(wslDistribution)).map(option => {
                const selected = agent === option.id;
                const isDefault = config?.defaultOrchestratorAgent === option.id;
                return (
                  <label
                    key={option.id}
                    data-testid={`create-session-agent-${option.id}`}
                    htmlFor={`create-session-agent-input-${option.id}`}
                    className={cn(
                      'flex cursor-default items-center justify-between rounded border px-3 py-2 text-left text-sm transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-interactive',
                      selected ? 'border-interactive bg-surface-selected text-text-primary' : 'border-border-primary text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                    )}
                  >
                    <input
                      id={`create-session-agent-input-${option.id}`}
                      type="radio"
                      name="orchestration-session-agent"
                      value={option.id}
                      aria-label={option.label}
                      checked={selected}
                      onChange={() => {
                        userSelectedAgent.current = true;
                        dispatch({ type: 'update', values: { agent: option.id } });
                      }}
                      className="sr-only"
                    />
                    <span>{option.label}</span>
                    {isDefault && <span className="text-[11px] text-text-muted">Default</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
          {distributions.length > 0 && (
            <div className="space-y-2">
              <label htmlFor="session-runtime" className="text-label font-medium text-text-primary">Run agent in</label>
              <select id="session-runtime" value={wslDistribution} onChange={event => {
                setWslDistribution(event.target.value);
                if (!event.target.value) dispatch({ type: 'update', values: { agent: supportedSessionAgent(agent) } });
              }} disabled={isSubmitting}
                className="w-full rounded border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary focus:ring-2 focus:ring-interactive">
                <option value="">Windows</option>
                {distributions.map(distribution => <option key={distribution} value={distribution}>WSL · {distribution}</option>)}
              </select>
              {wslDistribution && <p className="text-xs text-text-secondary">The agent must be installed in this distribution.</p>}
            </div>
          )}
          <details className="space-y-3">
            <summary className="cursor-default text-sm font-medium text-text-secondary">Launch command and behavior</summary>
            <SessionLaunchFields
              resume={customResume}
              onResumeChange={value => { userEditedLaunch.current = true; dispatch({ type: 'update', values: { customResume: value } }); }}
              command={launchCommand}
              profile={profile}
              customCommands={config?.customCommands}
              onCommandChange={value => { userEditedLaunch.current = true; dispatch({ type: 'update', values: { launchCommand: value } }); }}
              onProfileChange={value => { userEditedLaunch.current = true; dispatch({ type: 'update', values: { profile: value } }); }}
            />
          </details>
          {error && <p role="alert" className="text-sm text-status-error">{error}</p>}
        </ModalBody>
        <ModalFooter className="shrink-0">
          <Button type="button" variant="secondary" disabled={isSubmitting} onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={isSubmitting} loadingText="Creating…">Create Session</Button>
        </ModalFooter>
      </form>
  );
}
