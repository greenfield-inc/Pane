/** Read `owner/repo` and the number from a stored GitHub pull request URL. */
export function parsePullRequestUrl(url: string | undefined): { repo: string; number: number } | null {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url ?? '');
  if (!match) return null;
  return { repo: match[1], number: Number(match[2]) };
}
