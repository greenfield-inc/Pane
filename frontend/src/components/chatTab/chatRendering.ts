import { createContext, type ReactNode } from 'react';

/**
 * Renders a fenced block of a given language as something other than code, such as Autopilot's
 * `autopilot-items` rows. Keyed by the block's language; the content is the block's text.
 */
type ChatBlockRenderers = Readonly<Record<string, (content: string) => ReactNode>>;
/** Custom rendering a host view gives its chat: fenced blocks, and a person's message shown another way (or undefined to keep it). */
export interface ChatRendering {
  blocks?: ChatBlockRenderers;
  userMessage?: (text: string) => ReactNode | undefined;
  /** A queued message's label instead of its raw text (Autopilot's Pane lines), or undefined to keep the text. */
  queued?: (text: string) => string | undefined;
}
export const ChatBlocksContext = createContext<ChatRendering>({});
