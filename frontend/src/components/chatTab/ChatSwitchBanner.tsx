import { Fragment } from 'react';
import { AlertCircle, Info, X } from 'lucide-react';
import type { ChatTabSwitchBanner } from '../../../../shared/types/chatTab';
import { switchBannerCopy } from './switchBannerCopy';

/** The body with each "/resume" set as code, as the mock-up shows it. */
function withCommands(body: string) {
  return body.split('/resume').map((part, index) => <Fragment key={index}>{index > 0 && <code>/resume</code>}{part}</Fragment>);
}

/**
 * What Switch to chat did (D-282, D-278 style 3), shown at the top of the chat until closed
 * or another conversation is picked. "Pick another" opens the same picker as /resume.
 */
export function ChatSwitchBanner({ banner, busy = false, onPickAnother, onDismiss }: {
  banner: ChatTabSwitchBanner;
  busy?: boolean;
  onPickAnother: () => void;
  onDismiss: () => void;
}) {
  const copy = switchBannerCopy(banner);
  const Icon = copy.tone === 'warning' ? AlertCircle : Info;
  return <div className="chat-switch-banner-slot"><section role="status" aria-label={copy.title} className="chat-switch-banner" data-tone={copy.tone} data-kind={banner.kind}>
    <Icon className="chat-switch-banner-icon" aria-hidden="true" />
    <div className="chat-switch-banner-text">
      <p className="chat-switch-banner-title">{copy.title}</p>
      <p className="chat-switch-banner-body">{withCommands(copy.body)}</p>
    </div>
    {copy.pickAnother && <button type="button" className="chat-button chat-button-outline chat-switch-banner-pick" aria-label="Pick another conversation" disabled={busy} onClick={onPickAnother}>Pick another</button>}
    <button type="button" className="chat-icon chat-switch-banner-close" aria-label="Close" title="Close" disabled={busy} onClick={onDismiss}><X className="h-4 w-4" /></button>
  </section></div>;
}
