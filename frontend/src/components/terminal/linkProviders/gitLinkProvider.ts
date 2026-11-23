import type { ILink, ILinkProvider } from '@xterm/xterm';
import type { LinkProviderConfig } from './types';
import { urlLinkHandlers } from './urlLink';

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
  // A commit hash stands alone and mixes letters and digits: a timestamp, a word like "deadbeef", a
  // UUID part, or hex inside a path or URL is no commit, and a plain click on one would open a 404.
  const GIT_SHA = /(?<![\w./-])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])([0-9a-f]{7,40})(?![\w./-])/gi;
  const ISSUE_REF = /(?:^|[\s(])#(\d+)\b/g;
  const CROSS_REPO_ISSUE = /([a-z0-9_-]+\/[a-z0-9_-]+)#(\d+)/gi;

  return {
    provideLinks(lineNumber: number, callback: (links: ILink[] | undefined) => void) {
      const line = config.terminal.buffer.active.getLine(lineNumber);
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
            start: { x: shaMatch.index + 1, y: lineNumber + 1 },
            end: { x: shaMatch.index + shaMatch[0].length + 1, y: lineNumber + 1 },
          },
          text: sha,
          ...urlLinkHandlers(config, commitUrl),
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
            start: { x: issueMatch.index + 1, y: lineNumber + 1 },
            end: { x: issueMatch.index + issueMatch[0].length + 1, y: lineNumber + 1 },
          },
          text: `#${issueNumber}`,
          ...urlLinkHandlers(config, issueUrl),
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
            start: { x: crossRepoMatch.index + 1, y: lineNumber + 1 },
            end: { x: crossRepoMatch.index + crossRepoMatch[0].length + 1, y: lineNumber + 1 },
          },
          text: `${repo}#${issueNumber}`,
          ...urlLinkHandlers(config, crossRepoUrl),
        });
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}
