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
