/**
 * iOS smart punctuation, which comes on with autocorrect, swaps characters a
 * shell reads for look-alikes it doesn't: curly quotes, an em dash for `--`,
 * an ellipsis for `...`. React Native has no prop to turn it off, so the
 * terminal box swaps them back as they're typed.
 */
const REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/[“”„‟]/g, '"'],
  [/[‘’‚‛]/g, '\''],
  [/—/g, '--'],
  [/…/g, '...'],
];

export function straightenSmartPunctuation(text: string): string {
  return REPLACEMENTS.reduce((result, [pattern, plain]) => result.replace(pattern, plain), text);
}

/**
 * Straightens only the span one keyboard edit changed, found by trimming what
 * `previous` and `next` share at each end. Text already in the draft, such as a
 * path inserted with the Paste button, keeps its exact characters.
 */
export function straightenKeyboardEdit(previous: string, next: string): string {
  const shortest = Math.min(previous.length, next.length);
  let start = 0;
  while (start < shortest && previous[start] === next[start]) start += 1;
  let shared = 0;
  while (shared < shortest - start && previous[previous.length - 1 - shared] === next[next.length - 1 - shared]) shared += 1;
  const end = next.length - shared;
  return next.slice(0, start) + straightenSmartPunctuation(next.slice(start, end)) + next.slice(end);
}
