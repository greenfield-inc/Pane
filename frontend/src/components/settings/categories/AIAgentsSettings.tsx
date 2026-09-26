import type { CustomCommandResume } from '../../../../../shared/types/customCommandResume';
import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { ImmediateToggle, SegmentedControl } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import { API } from '../../../utils/api';
import type { PaneChatAgent } from '../../../../../shared/types/paneChat';
import { SessionLaunchFields } from '../../SessionLaunchFields';
import { DEFAULT_SESSION_PROFILE } from '../../../../../shared/types/sessionProfile';
import { visibleAgentPresets } from '../../../utils/agentPresets';

const PANE_CHAT_AGENT_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
} satisfies Record<PaneChatAgent, string>;

const paneChatAgentOptions = visibleAgentPresets().map(({ id }) => ({ id, label: PANE_CHAT_AGENT_LABELS[id] }));

interface AIAgentsSettingsProps {
  persistence: SettingsPersistence;
  onDirtyChange: (dirty: boolean) => void;
}
export function AIAgentsSettings({ persistence, onDirtyChange }: AIAgentsSettingsProps) {
  const config = persistence.config!;
  const [claudePath, setClaudePath] = useState(config.claudeExecutablePath ?? '');
  const [sessionResume, setSessionResume] = useState<CustomCommandResume | null>(config.defaultSessionResume ?? null);
  const [sessionCommand, setSessionCommand] = useState(config.defaultSessionCommand ?? '');
  const [sessionProfile, setSessionProfile] = useState(config.defaultSessionProfile ?? DEFAULT_SESSION_PROFILE);
  const claudeDirty = claudePath !== (config.claudeExecutablePath ?? '');
  const sessionDirty = JSON.stringify(sessionResume) !== JSON.stringify(config.defaultSessionResume ?? null) || sessionCommand !== (config.defaultSessionCommand ?? '') || sessionProfile !== (config.defaultSessionProfile ?? DEFAULT_SESSION_PROFILE);
  const dirty = claudeDirty || sessionDirty;

  useEffect(() => setSessionResume(config.defaultSessionResume ?? null), [config.defaultSessionResume]);
  useEffect(() => setSessionCommand(config.defaultSessionCommand ?? ''), [config.defaultSessionCommand]);
  useEffect(() => setSessionProfile(config.defaultSessionProfile ?? DEFAULT_SESSION_PROFILE), [config.defaultSessionProfile]);

  useEffect(() => setClaudePath(config.claudeExecutablePath ?? ''), [config.claudeExecutablePath]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const applyClaudePath = async () => {
    const saved = await persistence.saveConfig('claude-executable', { claudeExecutablePath: claudePath.trim() });
    if (saved) onDirtyChange(sessionDirty);
  };

  return (
    <SettingsPage title="AI & Agents" description="Application-wide defaults for Sessions and coding-agent integrations.">
      <SettingsSection title="Agent defaults">
        <SettingRow
          settingId="default-pane-chat-agent"
          label="Default Sessions agent"
          description="Choose the agent used when a Session opens a new orchestration terminal."
          saveState={persistence.saveStates['default-pane-chat-agent']}
        >
          {/* The legacy accessible name remains stable for existing shortcuts and fixtures. */}
          <SegmentedControl<PaneChatAgent>
            label="Default Pane Chat agent"
            value={config.defaultOrchestratorAgent ?? 'claude'}
            options={paneChatAgentOptions}
            onChange={(value) => void persistence.saveConfig('default-pane-chat-agent', { defaultOrchestratorAgent: value })}
          />
        </SettingRow>
        <SettingRow
          settingId="agent-context"
          label="Publish Pane instructions to AGENTS.md"
          description="Adds a managed block to active repositories so coding agents can discover RunPane commands."
          saveState={persistence.saveStates['agent-context']}
        >
          <ImmediateToggle
            label="Publish Pane instructions to AGENTS.md"
            value={config.agentContext?.managedAgentsMd !== false}
            onSave={(value) => persistence.saveConfig('agent-context', { agentContext: { managedAgentsMd: value } })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Session defaults">
        <SettingRow
          settingId="session-defaults"
          label="Launch command and behavior"
          description="Used for new Sessions. Existing Sessions keep their saved settings."
          saveState={persistence.saveStates['session-defaults']}
          align="start"
        >
          <div className="w-full space-y-3 sm:max-w-xl">
            <SessionLaunchFields resume={sessionResume} onResumeChange={setSessionResume} command={sessionCommand} profile={sessionProfile} customCommands={config.customCommands} onCommandChange={setSessionCommand} onProfileChange={setSessionProfile} />
            <div className="flex justify-end">
              <Button type="button" size="sm" disabled={!sessionDirty} onClick={() => void persistence.saveConfig('session-defaults', { defaultSessionCommand: sessionCommand, defaultSessionResume: sessionResume, defaultSessionProfile: sessionProfile })}>Apply Session defaults</Button>
            </div>
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Claude CLI">
        <SettingRow
          settingId="claude-executable"
          label="Custom Claude executable"
          description="Application-wide executable override. Leave empty to use the claude command from PATH."
          saveState={persistence.saveStates['claude-executable']}
          align="start"
        >
          <div className="w-full space-y-2 sm:w-96">
            <div className="flex gap-2">
              <Input
                aria-label="Claude executable path"
                value={claudePath}
                onChange={(event) => setClaudePath(event.target.value)}
                placeholder="/usr/local/bin/claude"
                fullWidth
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<FolderOpen className="h-4 w-4" />}
                onClick={async () => {
                  const result = await API.dialog.openFile({
                    title: 'Select Claude Executable',
                    buttonLabel: 'Select',
                    properties: ['openFile'],
                    filters: [{ name: 'Executables', extensions: ['*'] }],
                  });
                  if (result.success && result.data) setClaudePath(result.data);
                }}
              >
                Browse
              </Button>
            </div>
            <div className="flex justify-end">
              <Button type="button" size="sm" disabled={!claudeDirty} onClick={applyClaudePath}>Apply</Button>
            </div>
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
