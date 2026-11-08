import type { ChatTabSwitchBanner } from '../../../../shared/types/chatTab';

export interface SwitchBannerCopy {
  /** `warning`: Pane guessed, and the guess may be wrong. `info`: the chat started new. */
  tone: 'warning' | 'info';
  title: string;
  body: string;
  pickAnother: boolean;
}

const NOT_SURE = 'Pane wasn\'t sure which conversation the terminal was on';

/** The approved wording for what Switch to chat did (cover sheet v2, Exact copy). */
export function switchBannerCopy(banner: ChatTabSwitchBanner): SwitchBannerCopy {
  switch (banner.kind) {
    case 'most-recent': return {
      tone: 'warning', title: 'Opened the most recent conversation here', pickAnother: true,
      body: `${NOT_SURE}, so it opened the latest one in this folder. Not the right one? Type /resume or pick another.`,
    };
    case 'none': return { tone: 'info', title: 'Started a new conversation', pickAnother: false, body: `${NOT_SURE}, and this folder has none to open, so this chat starts new.` };
    case 'known-empty': return { tone: 'info', title: 'Started a new conversation', pickAnother: false, body: 'The terminal\'s conversation had no messages yet, so there was nothing to carry over.' };
    case 'list-failed': return {
      tone: 'info', title: 'Started a new conversation', pickAnother: false,
      body: `${NOT_SURE} and couldn't list this folder's conversations (${banner.reason.trim().replace(/\.+$/, '')}), so this chat starts new. Type /resume to try again.`,
    };
  }
}
