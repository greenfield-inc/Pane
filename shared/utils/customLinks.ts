import type { CustomLink } from '../types/customLinks';

export interface CustomLinkMatch {
  end: number;
  start: number;
  text: string;
  url: string;
}

const TEMPLATE_GROUP = /\$(\d)/g;
const WEB_URL = /^https?:\/\/\S+$/i;

/** Why this pattern can't make links, or undefined when it can. */
export function customLinkPatternProblem(pattern: string): string | undefined {
  if (!pattern) {
    return 'Pattern is required';
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    return `Not a regular expression: ${error instanceof Error ? error.message : String(error)}`;
  }
  return regex.test('') ? 'Pattern must not match empty text' : undefined;
}

/** Why this template can't make links, or undefined when it can. */
export function customLinkUrlProblem(urlTemplate: string): string | undefined {
  return WEB_URL.test(urlTemplate.trim()) ? undefined : 'Link must be a web address starting with http:// or https://';
}

export function customLinkProblem(link: Pick<CustomLink, 'pattern' | 'urlTemplate'>): string | undefined {
  return customLinkPatternProblem(link.pattern) ?? customLinkUrlProblem(link.urlTemplate);
}

/**
 * The template with `$0`–`$9` filled in, or undefined when a group can't be URL-encoded (half
 * of an emoji) or the result isn't a web address.
 */
function fillTemplate(urlTemplate: string, groups: RegExpExecArray): string | undefined {
  try {
    const url = urlTemplate.trim().replace(TEMPLATE_GROUP, (_, index: string) => encodeURIComponent(groups[Number(index)] ?? ''));
    return WEB_URL.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The links in one line of text. Where two links overlap, the one listed first wins. */
export function findCustomLinks(text: string, links: readonly CustomLink[]): CustomLinkMatch[] {
  const found: CustomLinkMatch[] = [];
  for (const link of links.filter(item => item.enabled && !customLinkProblem(item))) {
    const regex = new RegExp(link.pattern, 'g');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (!match[0]) {
        regex.lastIndex++;
        continue;
      }
      const start = match.index;
      const end = start + match[0].length;
      if (found.some(other => start < other.end && other.start < end)) {
        continue;
      }
      const url = fillTemplate(link.urlTemplate, match);
      if (url !== undefined) {
        found.push({ end, start, text: match[0], url });
      }
    }
  }
  return found.sort((a, b) => a.start - b.start);
}
