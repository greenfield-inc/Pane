import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Bot,
  BrainCircuit,
  Gauge,
  GitBranch,
  Keyboard,
  Link2,
  Monitor,
  Settings,
  Shield,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react';
import type { SettingsCategoryId, SettingsSettingId } from '../../types/settings';

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
    description: 'Startup, application updates, and feedback.',
    icon: Settings,
    settingIds: ['automatic-updates', 'check-updates-now', 'send-feedback', 'start-on-login', 'keep-awake'],
    aliases: ['startup', 'updates', 'feedback', 'bug report', 'feature request', 'github issue', 'login', 'sleep', 'caffeinate', 'awake', 'power'],
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
    description: 'Terminal display, references, shell, and power behavior.',
    icon: Terminal,
    settingIds: ['terminal-font-family', 'terminal-font-size', 'terminal-power-mode', 'terminal-reference-paste-mode', 'terminal-reference-line-count', 'terminal-shell'],
    aliases: ['font', 'shell', 'scrollback', 'gpu', 'battery'],
  },
  {
    id: 'ai-agents',
    label: 'AI & Agents',
    description: 'Agent defaults, context, and CLI installations.',
    icon: Bot,
    settingIds: ['default-pane-chat-agent', 'mcp-registration', 'mcp-toolsets', 'agent-context', 'session-defaults', 'claude-executable'],
    aliases: ['claude', 'codex', 'cursor', 'pane chat', 'agents.md', 'mcp', 'tools'],
  },
  {
    id: 'usage',
    label: 'Usage & Limits',
    description: 'Agent token usage, costs, and subscription limits.',
    icon: Gauge,
    settingIds: [],
    aliases: ['codex', 'usage', 'limits', 'quota', 'plan', 'rate limit'],
  },
  {
    id: 'worktrees-git',
    label: 'Worktrees & Git',
    description: 'Defaults for commits, pull requests, and new worktrees.',
    icon: GitBranch,
    settingIds: ['commit-footer', 'git-attribution', 'auto-rename-pr', 'worktree-file-sync'],
    aliases: ['git', 'worktree', 'commit', 'pull request', 'pr', 'attribution', 'committer', 'author'],
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
    description: 'Remote Pane hosts and saved connections.',
    icon: Link2,
    settingIds: ['remote-pane', 'remote-host-setup', 'remote-connections', 'remote-advanced-host'],
    aliases: ['remote pane', 'daemon', 'tailscale', 'cloud vm', 'vm', 'host'],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    description: 'Provider credentials and voice transcription.',
    icon: BrainCircuit,
    settingIds: ['voice-transcription'],
    aliases: ['fal', 'openrouter', 'deepgram', 'voice', 'dictation'],
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    description: 'Application and terminal snippet hotkeys.',
    icon: Keyboard,
    settingIds: ['keyboard-shortcuts', 'command-palette-shortcut', 'kitty-keyboard', 'terminal-shortcuts'],
    aliases: ['hotkeys', 'keyboard', 'snippets', 'kitty', 'key reporting'],
  },
  {
    id: 'privacy',
    label: 'Privacy',
    description: 'Analytics and data-sharing choices.',
    icon: Shield,
    settingIds: ['analytics'],
    aliases: ['analytics', 'telemetry', 'tracking'],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    description: 'Diagnostics, terminal backend, and environment paths.',
    icon: SlidersHorizontal,
    settingIds: ['session-progress', 'verbose-logging', 'developer-mode', 'journey-timings', 'pty-host', 'additional-paths'],
    aliases: ['debug', 'verbose', 'developer', 'performance', 'timings', 'pty', 'path'],
  },
] as const;

export function settingDomId(settingId: SettingsSettingId): string {
  return `settings-${settingId}`;
}
