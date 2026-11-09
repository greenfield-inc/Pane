import { createElement, type ReactElement } from 'react';
import { AiderIcon, ClaudeIcon, CursorIcon, GeminiIcon, OpenAIIcon, OpenCodeIcon, PiIcon } from './BrandIcons';

/** Lookup map used to dynamically show the right icon for any terminal panel. */
const CLI_BRAND_ICONS = {
  claude: ClaudeIcon,
  codex: OpenAIIcon,
  cursor: CursorIcon,
  opencode: OpenCodeIcon,
  gemini: GeminiIcon,
  aider: AiderIcon,
};

/**
 * Names too short to find inside other words (`api`, `pip`, `ssh pi@host`):
 * they match only as the first word, or the executable a path ends in.
 */
const CLI_BRAND_WORD_ICONS = {
  pi: PiIcon,
};

/** Returns the matching brand icon for a command or title, if one is known. */
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
