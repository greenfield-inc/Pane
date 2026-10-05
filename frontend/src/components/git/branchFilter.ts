/**
 * Narrowing a branch list down to what the user is typing.
 *
 * Pure and separate from the combobox so the ranking rules can be checked
 * directly: with hundreds of branches, *which* ten are shown first is the whole
 * usefulness of the picker.
 */

/** Rendering more than this at once is wasted work — nobody scrolls that far. */
const MAX_VISIBLE_BRANCHES = 200;

export function filterBranches(
  branches: string[],
  query: string,
  limit: number = MAX_VISIBLE_BRANCHES,
): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return branches.slice(0, limit);

  // Rank rather than merely filter: typing "main" must not bury `main` itself
  // under `feature/maintenance-window`.
  const scored: Array<{ name: string; score: number; index: number }> = [];
  branches.forEach((name, index) => {
    const haystack = name.toLowerCase();
    const at = haystack.indexOf(needle);
    if (at < 0) return;

    const score = haystack === needle ? 0
      : at === 0 ? 1
        // A match right after a separator reads as a prefix too: "fix" in
        // "feature/fix-thing".
        : /[/\-_]/.test(haystack[at - 1]) ? 2
          : 3;
    scored.push({ name, score, index });
  });

  return scored
    .sort((a, b) => (a.score - b.score) || (a.index - b.index))
    .slice(0, limit)
    .map(entry => entry.name);
}
