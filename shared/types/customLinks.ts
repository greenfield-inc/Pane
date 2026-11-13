import { boundary, type BoundarySchema } from '../validation/boundaryDecoder';

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

/** A saved custom link, as config.json and setup files carry it. */
export const customLinkSchema: BoundarySchema<CustomLink> = boundary.object({
  enabled: boundary.boolean,
  id: boundary.nonEmptyString,
  label: boundary.string,
  pattern: boundary.string,
  urlTemplate: boundary.string,
});
