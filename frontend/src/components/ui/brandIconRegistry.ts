import { createElement, type ReactElement } from 'react';
import { MessageSquare } from 'lucide-react';
import { AiderIcon, ClaudeIcon, CursorIcon, GeminiIcon, OpenAIIcon, OpenCodeIcon, PiIcon } from './BrandIcons';
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

/**
 * Keys too short to find inside other words (`api`, `pip`, `ssh pi@host`): they match
 * only as the first word, or the executable a path ends in.
 */
const CLI_BRAND_WORD_ICONS = {
  pi: PiIcon,
};

const BRAND_ICONS_BY_KEY = new Map(Object.entries({ ...CLI_BRAND_ICONS, ...CLI_BRAND_WORD_ICONS }));

/** Returns the brand icon whose key appears in a free-form command or terminal title, if one is known. */
export function getCliBrandIcon(nameOrCommand: string, className = 'w-4 h-4'): ReactElement | null {
  const normalizedName = nameOrCommand.toLowerCase();
  const firstWord = normalizedName.trim().split(/\s+/u)[0]?.split(/[\\/]/u).pop()?.replace(/\.(?:cmd|exe)$/u, '');
  for (const [word, IconComponent] of Object.entries(CLI_BRAND_WORD_ICONS)) {
    if (firstWord === word) return createElement(IconComponent, { className });
  }
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
  // Registry icons are single-colour SVGs drawn in currentColor; a mask paints them in the text colour, so they follow the theme.
  if (agent?.iconUrl) {
    const mask = `url("${agent.iconUrl}") center / contain no-repeat`;
    return createElement('span', { 'aria-hidden': true, className: `${className} inline-block bg-current`, style: { mask, WebkitMask: mask } });
  }
  return createElement(MessageSquare, { className });
}

/** The icon for an agent id with no catalog entry at hand: its config's icon, else the generic chat icon. */
export function agentIdIcon(id: string | undefined, className = 'w-4 h-4'): ReactElement {
  return agentIcon(id ? { icon: agentConfig(id)?.icon } : undefined, className);
}
