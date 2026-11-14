import type { LucideIcon } from 'lucide-react';
import {
  ArrowUpDown,
  Bell,
  Bot,
  Boxes,
  BrainCircuit,
  Gauge,
  Inbox,
  GitBranch,
  Keyboard,
  KeyRound,
  Link,
  Link2,
  Monitor,
  Navigation,
  Settings,
  Shield,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react';
import type { SettingsCategoryId, SettingsSettingId } from '../../types/settings';
import { CONFIGURED_AGENT_IDS, agentLabel } from '../../../../shared/agents';

export interface SettingsCategoryDefinition {
  id: SettingsCategoryId;
  label: string;
  description: string;
  icon: LucideIcon;
  settingIds: readonly SettingsSettingId[];
  aliases: readonly string[];
  availability?: { disabled: boolean; reason: string };
}

export const SETTINGS_CATEGORIES: readonly SettingsCategoryDefinition[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Startup, application updates, feedback, pausing idle Panes, and opening files.',
    icon: Settings,
    settingIds: ['automatic-updates', 'check-updates-now', 'send-feedback', 'start-on-login', 'keep-awake', 'resume-paused-on-open', 'auto-pause', 'html-file-open-mode'],
    aliases: ['startup', 'updates', 'feedback', 'bug report', 'feature request', 'github issue', 'login', 'sleep', 'caffeinate', 'awake', 'power', 'battery', 'plugged in', 'lid', 'pause', 'paused', 'resume', 'idle', 'auto-pause', 'html', 'preview', 'open html', 'explorer', 'source'],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme, scale, and sidebar presentation.',
    icon: Monitor,
    settingIds: ['appearance-mode', 'theme', 'system-light-theme', 'system-dark-theme', 'high-contrast', 'ui-scale', 'sidebar-pane-rows'],
    aliases: ['theme', 'display', 'sidebar', 'zoom', 'contrast', 'accessibility'],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    description: 'Terminal display, selection, references, shell, and power behavior.',
    icon: Terminal,
    settingIds: ['terminal-font-family', 'terminal-font-size', 'terminal-power-mode', 'terminal-copy-on-select', 'terminal-references-enabled', 'terminal-reference-paste-mode', 'terminal-reference-line-count', 'terminal-shell'],
    aliases: ['font', 'shell', 'scrollback', 'gpu', 'battery', 'copy', 'select', 'selection', 'clipboard', 'popover', '@', 'mention', 'picker'],
  },
  {
    id: 'links',
    label: 'Links',
    description: 'Your own clickable links in terminal output, such as issue keys.',
    icon: Link,
    settingIds: ['custom-links'],
    aliases: ['link', 'url', 'regex', 'pattern', 'issue', 'ticket', 'jira', 'linear', 'tracker', 'clickable'],
  },
  {
    id: 'ai-agents',
    label: 'AI & Agents',
    description: 'Agent defaults, context, and CLI installations.',
    icon: Bot,
    settingIds: ['chat-tabs', 'chat-tab-keys', 'default-pane-chat-agent', 'mcp-registration', 'mcp-toolsets', 'answer-prompts-from-pane', 'agent-skill', 'agent-context', 'session-import', 'session-defaults', 'claude-executable'],
    aliases: ['chat tabs', 'chat', 'pane chat', 'permission', 'prompts', 'hooks', 'agents.md', 'mcp', 'tools', 'skill', 'import', 'migrate', 'conductor'],
  },
  {
    id: 'agents',
    label: 'Agents',
    description: 'The agents this machine can open as chat tabs, and what each one supports.',
    icon: Boxes,
    settingIds: ['chat-agents'],
    aliases: ['agents', 'acp', 'install', 'chat agents', 'capabilities', 'full access', ...CONFIGURED_AGENT_IDS.map(id => agentLabel(id).toLowerCase())],
  },
  {
    id: 'notify',
    label: 'Approvals',
    description: 'What agents are waiting on you for, answered from any app.',
    icon: Inbox,
    settingIds: ['notify-enabled', 'notify-cards-on', 'notify-show-outside', 'notify-position', 'notify-shortcut', 'notify-updates-hide-after', 'notify-sound', 'notify-show-details'],
    aliases: ['notify', 'approvals', 'questions', 'approve', 'answer', 'ask', 'strip', 'answer all', 'shortcut', 'updates', 'sound', 'details', 'inbox', 'show cards on', 'machine', 'computer'],
  },
  {
    id: 'autopilot',
    label: 'Autopilot',
    description: 'Your own instructions for Autopilot.',
    icon: Navigation,
    settingIds: ['autopilot-instructions'],
    aliases: ['autopilot', 'instructions', 'prompt', 'custom prompt', 'tune', 'behavior'],
  },
  {
    id: 'usage',
    label: 'Usage & Limits',
    description: 'Agent token usage, costs, and subscription limits.',
    icon: Gauge,
    settingIds: ['usage-leaderboard'],
    aliases: ['codex', 'usage', 'limits', 'quota', 'plan', 'rate limit'],
  },
  {
    id: 'worktrees-git',
    label: 'Worktrees & Git',
    description: 'Defaults for commits, pull requests, new worktrees, opening them in your IDE, and how long archived folders are kept.',
    icon: GitBranch,
    settingIds: ['commit-footer', 'git-attribution', 'auto-rename-pr', 'worktree-file-sync', 'default-ide-command', 'archive-retention'],
    aliases: ['git', 'worktree', 'commit', 'pull request', 'pr', 'attribution', 'committer', 'author', 'ide', 'editor', 'open in ide', 'archive', 'retention', 'delete', 'cleanup', 'scratch', 'disk space'],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Desktop alerts, permissions, and sound.',
    icon: Bell,
    settingIds: ['notification-permission', 'notification-sound', 'desktop-notifications'],
    aliases: ['alerts', 'sound', 'desktop'],
  },
  {
    id: 'remote-access',
    label: 'Remote Access',
    description: 'Your machines, who can connect, and paired phones, computers and glasses.',
    icon: Link2,
    settingIds: ['remote-machines', 'remote-visibility', 'remote-address', 'remote-password', 'remote-pair-phone', 'remote-glasses', 'remote-linked-computers', 'remote-relay-address', 'remote-pane', 'remote-host-setup', 'remote-advanced-host'],
    aliases: ['remote pane', 'daemon', 'tailscale', 'cloud vm', 'vm', 'host', 'visibility', 'password', 'my machines', 'machines', 'switch machine', 'workspaces', 'glasses', 'even g2', 'phone', 'mobile', 'devices', 'connection code', 'qr', 'qr code', 'scan', 'pair', 'pair a phone', 'relay', 'relay address', 'self-host', 'linked computers', 'your computers', 'unlink'],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    description: 'Provider credentials and voice transcription.',
    icon: BrainCircuit,
    settingIds: ['voice-transcription', 'apns-credentials'],
    aliases: ['fal', 'openrouter', 'deepgram', 'voice', 'dictation', 'apns', 'push', 'notifications', 'keys'],
  },
  {
    id: 'secrets',
    label: 'Secrets',
    description: 'Values agents use through runpane secrets exec, on every machine.',
    icon: KeyRound,
    settingIds: ['pane-secrets'],
    aliases: ['secret', 'secrets', 'api key', 'token', 'password', 'credentials', 'keychain', 'env', 'environment', 'runpane secrets'],
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    description: 'Application and terminal snippet hotkeys.',
    icon: Keyboard,
    settingIds: ['keyboard-shortcuts', 'command-palette-shortcut', 'keyboard-shortcut-map', 'kitty-keyboard', 'terminal-shortcuts'],
    aliases: ['hotkeys', 'keyboard', 'keybindings', 'keybinding', 'rebind', 'remap', 'agent shortcut', 'snippets', 'kitty', 'key reporting'],
  },
  {
    id: 'privacy',
    label: 'Privacy',
    description: 'Analytics, data-sharing choices, and browser logins.',
    icon: Shield,
    settingIds: ['analytics', 'browser-data'],
    aliases: ['analytics', 'telemetry', 'tracking', 'browser', 'cookies', 'logins', 'sign out'],
  },
  {
    id: 'import-export',
    label: 'Import & Export',
    description: 'Move your Pane setup between computers.',
    icon: ArrowUpDown,
    settingIds: ['setup-transfer'],
    aliases: ['export', 'import', 'backup', 'transfer', 'move', 'new computer', 'settings file'],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    description: 'Diagnostics, terminal backend, environment paths, and experimental features.',
    icon: SlidersHorizontal,
    settingIds: ['verbose-logging', 'developer-mode', 'journey-timings', 'pty-host', 'additional-paths', 'mission-control', 'autopilot', 'notes', 'attention-inbox'],
    aliases: ['debug', 'verbose', 'developer', 'performance', 'timings', 'pty', 'path', 'experimental', 'mission control', 'inbox', 'attention', 'autopilot', 'agent above sessions'],
  },
] as const;

export function settingDomId(settingId: SettingsSettingId): string {
  return `settings-${settingId}`;
}
