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
  /** The Pane the chat's web links open in (LinkPopover, Settings > Links); without one they open in the system browser. */
  paneId?: string;
}
export const ChatBlocksContext = createContext<ChatRendering>({});

/**
 * The agent's photo in the chat (T-63 round 5), given by the desktop's chat tab while Profiles is
 * on: beside each reply when the chat is at least 800 px wide, else with its name at the top.
 * `current` is the profile the tab runs now; `avatar` draws a profile ref's photo.
 */
export interface ChatPhoto {
  current?: string;
  avatar: (ref: string, size: number) => ReactNode;
  /** The name and ref shown at the top of a narrow chat, for the current profile. */
  heading: ReactNode;
}
