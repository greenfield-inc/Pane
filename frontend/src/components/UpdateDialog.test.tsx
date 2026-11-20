import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Dialog from '@radix-ui/react-dialog';
import { UpdateDialogContent, type UpdateDialogContentProps } from './UpdateDialog';

const noop = () => {};

const baseProps: UpdateDialogContentProps = {
  onClose: noop,
  versionInfo: {
    current: '2.4.231',
    latest: '2.4.232',
    hasUpdate: true,
    releaseUrl: 'https://github.com/greenfield-inc/Pane/releases/tag/v2.4.232',
    downloadUrl: 'https://github.com/greenfield-inc/Pane/releases/download/v2.4.232/Pane.dmg',
  },
  updateState: 'idle',
  downloadProgress: null,
  error: null,
  message: null,
  isPackaged: true,
  canUseSeamlessUpdater: false,
  isResolvingUpdateMode: false,
  onStartUpdate: noop,
  onCopyUpdateCommand: noop,
  onOpenTerminalWithCommand: noop,
  onInstallDownloadedUpdate: noop,
};

// ModalHeader's title needs a Dialog around it; Dialog.Root renders no markup of its own.
const render = (props: Partial<UpdateDialogContentProps>) =>
  renderToStaticMarkup(
    <Dialog.Root open>
      <UpdateDialogContent {...baseProps} {...props} />
    </Dialog.Root>,
  );

const countViewOnGitHub = (markup: string) => markup.match(/>View on GitHub</g)?.length ?? 0;

// Clicking the buttons belongs to the app's QA; this suite has no DOM to dispatch events in.
describe('Update dialog on macOS without the seamless updater', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows one View on GitHub button once the update is downloaded', () => {
    const markup = render({ updateState: 'downloaded' });

    expect(markup).toContain('Please install the update manually');
    expect(markup).toContain('Copy command and open Terminal');
    expect(countViewOnGitHub(markup)).toBe(1);
  });

  it('shows one View on GitHub button when the update fails', () => {
    const markup = render({ updateState: 'error', error: 'Failed to download update' });

    expect(markup).toContain('Manual Update Available');
    expect(markup).toContain('Copy command and open Terminal');
    expect(countViewOnGitHub(markup)).toBe(1);
  });
});
