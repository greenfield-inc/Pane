import { createElement, type ReactElement } from 'react';
import { AiderIcon, ClaudeIcon, CursorIcon, GeminiIcon, OpenAIIcon, OpenCodeIcon } from './BrandIcons';

/** Lookup map used to dynamically show the right icon for any terminal panel. */
export const CLI_BRAND_ICONS = {
  claude: ClaudeIcon,
  codex: OpenAIIcon,
  cursor: CursorIcon,
  opencode: OpenCodeIcon,
  gemini: GeminiIcon,
  aider: AiderIcon,
};

/** Returns the matching brand icon for a command or title, if one is known. */
export function getCliBrandIcon(nameOrCommand: string, className = 'w-4 h-4'): ReactElement | null {
  const normalizedName = nameOrCommand.toLowerCase();
  for (const [keyword, IconComponent] of Object.entries(CLI_BRAND_ICONS)) {
    if (normalizedName.includes(keyword)) return createElement(IconComponent, { className });
  }
  return null;
}
