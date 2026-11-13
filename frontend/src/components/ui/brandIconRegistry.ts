import { createElement, type ReactElement } from 'react';
import { MessageSquare } from 'lucide-react';
import { AiderIcon, ClaudeIcon, CursorIcon, GeminiIcon, OpenAIIcon, OpenCodeIcon } from './BrandIcons';
import { agentConfig } from '../../../../shared/agents';

/** Brand icons by icon key: the agents config's and the chat catalog's `icon`. */
const CLI_BRAND_ICONS = {
  claude: ClaudeIcon,
  codex: OpenAIIcon,
  cursor: CursorIcon,
  opencode: OpenCodeIcon,
  gemini: GeminiIcon,
  aider: AiderIcon,
};

const BRAND_ICONS_BY_KEY = new Map(Object.entries(CLI_BRAND_ICONS));

/** Returns the brand icon whose key appears in a free-form command or terminal title, if one is known. */
export function getCliBrandIcon(nameOrCommand: string, className = 'w-4 h-4'): ReactElement | null {
  const normalizedName = nameOrCommand.toLowerCase();
  for (const [keyword, IconComponent] of Object.entries(CLI_BRAND_ICONS)) {
    if (normalizedName.includes(keyword)) return createElement(IconComponent, { className });
  }
  return null;
}

/**
 * An agent's icon: the brand icon for its exact icon key, else its catalog image, else the
 * generic chat icon.
 */
export function agentIcon(agent: { icon?: string; iconUrl?: string } | undefined, className = 'w-4 h-4'): ReactElement {
  const brand = agent?.icon ? BRAND_ICONS_BY_KEY.get(agent.icon) : undefined;
  if (brand) return createElement(brand, { className });
  if (agent?.iconUrl) return createElement('img', { src: agent.iconUrl, alt: '', draggable: false, className: `${className} object-contain` });
  return createElement(MessageSquare, { className });
}

/** The icon for an agent id with no catalog entry at hand: its config's icon, else the generic chat icon. */
export function agentIdIcon(id: string | undefined, className = 'w-4 h-4'): ReactElement {
  return agentIcon(id ? { icon: agentConfig(id)?.icon } : undefined, className);
}
