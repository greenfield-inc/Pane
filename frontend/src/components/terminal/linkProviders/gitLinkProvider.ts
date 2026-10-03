import type { ILink, ILinkProvider } from '@xterm/xterm';
import type { LinkProviderConfig } from './types';

/**
 * Creates a git link provider that detects git SHAs and issue references.
 * Only active when GitHub remote URL is provided.
 */
export function createGitLinkProvider(config: LinkProviderConfig): ILinkProvider {
  // Only create provider if GitHub remote is configured
  if (!config.githubRemoteUrl) {
    return {
      provideLinks(_lineNumber: number, callback: (links: ILink[] | undefined) => void) {
        callback(undefined);
      },
    };
  }

  // Regex patterns for git-related content
  const GIT_SHA = /\b([0-9a-f]{7,40})\b/gi; // Accept some false positives
  const ISSUE_REF = /(?:^|[\s(])#(\d+)\b/g;
  const CROSS_REPO_ISSUE = /([a-z0-9_-]+\/[a-z0-9_-]+)#(\d+)/gi;

  return {
    // xterm passes a 1-based buffer line; buffer.getLine is 0-based and link
    // ranges are 1-based, so the range y is the line number as given.
    provideLinks(lineNumber: number, callback: (links: ILink[] | undefined) => void) {
      const line = config.terminal.buffer.active.getLine(lineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const text = line.translateToString();
      const links: ILink[] = [];

      // Match Git SHAs
      GIT_SHA.lastIndex = 0;
      let shaMatch;
      while ((shaMatch = GIT_SHA.exec(text)) !== null) {
        const sha = shaMatch[1];
        const commitUrl = `${config.githubRemoteUrl}/commit/${sha}`;

        links.push({
          range: {
            start: { x: shaMatch.index + 1, y: lineNumber },
            end: { x: shaMatch.index + shaMatch[0].length + 1, y: lineNumber },
          },
          text: sha,
          activate: (event: MouseEvent) => {
            config.onActivateUrl(commitUrl, event);
          },
          hover: (event: MouseEvent) => {
            config.onShowTooltip(event, commitUrl, config.urlHoverHint);
          },
          leave: () => {
            config.onHideTooltip();
          },
        });
      }

      // Match issue references (#123)
      ISSUE_REF.lastIndex = 0;
      let issueMatch;
      while ((issueMatch = ISSUE_REF.exec(text)) !== null) {
        const issueNumber = issueMatch[1];
        const issueUrl = `${config.githubRemoteUrl}/issues/${issueNumber}`;

        links.push({
          range: {
            start: { x: issueMatch.index + 1, y: lineNumber },
            end: { x: issueMatch.index + issueMatch[0].length + 1, y: lineNumber },
          },
          text: `#${issueNumber}`,
          activate: (event: MouseEvent) => {
            config.onActivateUrl(issueUrl, event);
          },
          hover: (event: MouseEvent) => {
            config.onShowTooltip(event, issueUrl, config.urlHoverHint);
          },
          leave: () => {
            config.onHideTooltip();
          },
        });
      }

      // Match cross-repo issue references (org/repo#123)
      CROSS_REPO_ISSUE.lastIndex = 0;
      let crossRepoMatch;
      while ((crossRepoMatch = CROSS_REPO_ISSUE.exec(text)) !== null) {
        const repo = crossRepoMatch[1];
        const issueNumber = crossRepoMatch[2];
        const crossRepoUrl = `https://github.com/${repo}/issues/${issueNumber}`;

        links.push({
          range: {
            start: { x: crossRepoMatch.index + 1, y: lineNumber },
            end: { x: crossRepoMatch.index + crossRepoMatch[0].length + 1, y: lineNumber },
          },
          text: `${repo}#${issueNumber}`,
          activate: (event: MouseEvent) => {
            config.onActivateUrl(crossRepoUrl, event);
          },
          hover: (event: MouseEvent) => {
            config.onShowTooltip(event, crossRepoUrl, config.urlHoverHint);
          },
          leave: () => {
            config.onHideTooltip();
          },
        });
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}
