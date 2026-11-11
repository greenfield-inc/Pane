/**
 * Text in a terminal that matches `pattern` becomes a link to `urlTemplate`, where `$0` is
 * the whole match and `$1` to `$9` are its capture groups, e.g. `\bPROJ-\d+\b` opening
 * `https://example.atlassian.net/browse/$0`.
 */
export interface CustomLink {
  enabled: boolean;
  id: string;
  label: string;
  pattern: string;
  urlTemplate: string;
}
