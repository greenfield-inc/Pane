/**
 * Profiles text in bundled skills (T-63). A skill marks the parts that hold only while Profiles is on
 * with `<!-- pane:profiles -->` … `<!-- /pane:profiles -->`, and the text Pane had before Profiles with
 * `<!-- pane:no-profiles -->` … `<!-- /pane:no-profiles -->`, either as lines of their own around a
 * block or inline around part of a line. `withProfilesText` keeps one side, without its markers, and
 * drops the other, so with Profiles off an agent reads what it read before T-63.
 */
const TAGS = { on: 'pane:profiles', off: 'pane:no-profiles' } as const;

function block(tag: string): RegExp {
  return new RegExp(`^[ \\t]*<!-- ${tag} -->[ \\t]*\\r?\\n([\\s\\S]*?)^[ \\t]*<!-- /${tag} -->[ \\t]*(?:\\r?\\n|$)`, 'gm');
}

function inline(tag: string): RegExp {
  return new RegExp(`<!-- ${tag} -->([\\s\\S]*?)<!-- /${tag} -->`, 'g');
}

export function withProfilesText(text: string, profilesOn: boolean): string {
  if (!text.includes('<!-- pane:profiles -->') && !text.includes('<!-- pane:no-profiles -->')) return text;
  const keep = profilesOn ? TAGS.on : TAGS.off;
  const drop = profilesOn ? TAGS.off : TAGS.on;
  return text
    .replace(block(drop), '').replace(inline(drop), '')
    .replace(block(keep), '$1').replace(inline(keep), '$1');
}
