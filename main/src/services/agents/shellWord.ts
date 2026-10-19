/**
 * Quote a value as one literal word for the shell that will read it.
 *
 * `shellType` is the terminal's shell as Pane records it: a name such as
 * `powershell` or `gitbash`, an executable name such as `pwsh.exe`, or a path
 * such as `/bin/zsh`. An unknown or missing shell is treated as POSIX.
 *
 * Returns undefined when the shell has no quoting that keeps the value literal
 * (cmd expands `%` and `!` and cannot escape `"` inside quotes); callers then
 * leave the argument out rather than emit a word the shell would rewrite.
 */
export function quoteShellWord(value: string, shellType: string | undefined): string | undefined {
  const shell = (shellType ?? '').split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
  if (shell === 'powershell' || shell === 'pwsh') {
    // PowerShell ends a single-quoted string at any of its single-quote characters, typographic ones included.
    return `'${value.replace(/['‘’‚‛]/g, quote => quote + quote)}'`;
  }
  if (shell === 'cmd') {
    // oxlint-disable-next-line no-control-regex -- control characters cannot be passed through cmd literally.
    return /[%!"\x00-\x1f\x7f]/.test(value) ? undefined : `"${value}"`;
  }
  if (shell === 'fish') {
    return `'${value.replace(/[\\']/g, character => `\\${character}`)}'`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
