import { detectAgentFromScreen, readAgentComposerText } from './agents/agentScreenSignature';
import { isCliAgentType } from './agents/agentIdentity';

const COMPOSER_PLACEHOLDER = /^(?:ask (?:codex|claude)\b|try\s+["“])/iu;
const HELD_INPUT_LIMIT = 120;

/**
 * A live terminal's viewport: all cells, and typed cells only (ghost cells,
 * such as dim or grey placeholders and prompt suggestions, blanked).
 */
export interface WorkspaceHeldInputScreen {
  screenText?: string;
  typedText?: string;
}

/**
 * Text typed into an agent's composer but not sent, read from the typed layer
 * the way `panels screen` reads composer.hasUndeliveredText: Claude's composer
 * box, Codex's prompt line, and for other agents the bottom prompt line.
 * Suggestions and placeholders are not input. Without a typed layer (no live
 * emulator) nothing is reported.
 */
export function extractWorkspaceHeldInput(
  agentType: string | undefined,
  screen: WorkspaceHeldInputScreen | undefined,
): string | undefined {
  const typedText = screen?.typedText;
  if (!typedText) return undefined;
  // A wrapper agent Pane has not confirmed yet is still read by its screen signature.
  const composerAgent = agentType !== undefined && isCliAgentType(agentType)
    ? agentType
    : detectAgentFromScreen(screen.screenText ?? typedText);
  const held = composerAgent === 'claude' || composerAgent === 'codex'
    ? readAgentComposerText(screen.screenText ?? typedText, composerAgent, { typedText })
    : bottomPromptLineInput(typedText);
  return held?.slice(0, HELD_INPUT_LIMIT);
}

// The composer is the bottom prompt line; an empty one holds nothing, even
// when an older `>` line (a sent message or a quote) sits above it.
function bottomPromptLineInput(typedText: string): string | undefined {
  const lines = typedText.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].trim().match(/^[>›❯▌](?:\s+(.*))?$/u);
    if (!match) continue;
    const input = match[1]?.trim();
    return input && !COMPOSER_PLACEHOLDER.test(input) ? input : undefined;
  }
  return undefined;
}
