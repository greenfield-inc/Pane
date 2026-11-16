import { describe, expect, it } from 'vitest';
import { quoteNativeArgument, quoteShellWord } from './shellWord';

describe('quoteNativeArgument', () => {
  const value = 'id $(x) `y` \'z\'';

  it('quotes like quoteShellWord when the shell passes the value on unchanged', () => {
    for (const shell of ['bash', 'zsh', 'fish', 'powershell', 'pwsh.exe', 'cmd', undefined]) {
      expect(quoteNativeArgument(value, shell)).toBe(quoteShellWord(value, shell));
    }
    expect(quoteNativeArgument('a "b"', 'bash')).toBe('\'a "b"\'');
  });

  it('gives no word for a double quote in PowerShell, which drops it from a native command line', () => {
    for (const shell of ['powershell', 'powershell.exe', 'pwsh', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']) {
      expect(quoteShellWord('a "b"', shell)).toBe('\'a "b"\'');
      expect(quoteNativeArgument('a "b"', shell)).toBeUndefined();
    }
  });

  it('keeps cmd\'s refusals', () => {
    for (const unsafe of ['a%b', 'a!b', 'a"b']) expect(quoteNativeArgument(unsafe, 'cmd.exe')).toBeUndefined();
  });
});
