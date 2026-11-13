;
;
export type { LinkProviderConfig,   } from './types';

import type { IDisposable } from '@xterm/xterm';
import type { LinkProviderConfig } from './types';
import { createFileLinkProvider } from './fileLinkProvider';
import { createGitLinkProvider } from './gitLinkProvider';
import { createCustomLinkProvider } from './customLinkProvider';

/**
 * Registers all link providers for the terminal.
 * Returns an array of disposables that should be cleaned up when the terminal is destroyed.
 */
export function registerAllLinkProviders(config: LinkProviderConfig): IDisposable[] {
  const disposables: IDisposable[] = [
    config.terminal.registerLinkProvider(createFileLinkProvider(config)),
  ];

  if (config.customLinks?.some(link => link.enabled)) {
    disposables.push(config.terminal.registerLinkProvider(createCustomLinkProvider(config)));
  }

  // Only register git provider if GitHub remote is configured
  if (config.githubRemoteUrl) {
    disposables.push(config.terminal.registerLinkProvider(createGitLinkProvider(config)));
  }

  return disposables;
}
