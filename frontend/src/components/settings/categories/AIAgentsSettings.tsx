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
  const dirty = claudePath !== (config.claudeExecutablePath ?? '');

  useEffect(() => setClaudePath(config.claudeExecutablePath ?? ''), [config.claudeExecutablePath]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const applyClaudePath = async () => {
    const saved = await persistence.saveConfig('claude-executable', { claudeExecutablePath: claudePath.trim() });
    if (saved) onDirtyChange(false);
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
          settingId="agent-skill"
          label="Install Pane skill for agents"
          description="Adds a Pane-managed skill to your home skill folders (~/.claude/skills and ~/.agents/skills) so agents in Pane terminals know how to use RunPane. Pane never touches skills it did not create; turning this off removes its skill."
          saveState={persistence.saveStates['agent-skill']}
        >
          <ImmediateToggle
            label="Install Pane skill for agents"
            value={config.agentContext?.homeSkill !== false}
            onSave={(value) => persistence.saveConfig('agent-skill', { agentContext: { homeSkill: value } })}
          />
        </SettingRow>
        <SettingRow
          settingId="agent-context"
          label="Publish Pane instructions to AGENTS.md"
          description="Edits files in your repositories: adds a marked Pane section to the AGENTS.md at each active repository's root, creating the file if needed. Off by default; turning it off removes only Pane's section."
          saveState={persistence.saveStates['agent-context']}
        >
          <ImmediateToggle
            label="Publish Pane instructions to AGENTS.md"
            value={config.agentContext?.managedAgentsMd === true}
            onSave={(value) => persistence.saveConfig('agent-context', { agentContext: { managedAgentsMd: value } })}
          />
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
              <Button type="button" size="sm" disabled={!dirty} onClick={applyClaudePath}>Apply</Button>
            </div>
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
