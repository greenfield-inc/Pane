;
;
export type { LinkProviderConfig,   } from './types';

import type { IDisposable } from '@xterm/xterm';
import type { LinkProviderConfig } from './types';
import { createFileLinkProvider } from './fileLinkProvider';
import { createGitLinkProvider } from './gitLinkProvider';
import { createPaneLinkProvider } from './paneLinkProvider';

/**
 * Registers all link providers for the terminal.
 * Returns an array of disposables that should be cleaned up when the terminal is destroyed.
 */
export function registerAllLinkProviders(config: LinkProviderConfig): IDisposable[] {
  const disposables: IDisposable[] = [
    config.terminal.registerLinkProvider(createPaneLinkProvider(config)),
    config.terminal.registerLinkProvider(createFileLinkProvider(config)),
  ];

  // Only register git provider if GitHub remote is configured
  if (config.githubRemoteUrl) {
    disposables.push(config.terminal.registerLinkProvider(createGitLinkProvider(config)));
  }

  return disposables;
}
