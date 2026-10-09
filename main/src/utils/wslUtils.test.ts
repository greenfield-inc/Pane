import { describe, expect, it } from 'vitest';
import { getDefaultWSLDistribution, getWSLShellSpawn, validateWSLAvailable, wslMountToWindowsPath } from './wslUtils';

describe('wslMountToWindowsPath', () => {
  it.each([
    ['/mnt/c/Users/me/preview.html', 'C:\\Users\\me\\preview.html'],
    ['/mnt/d', 'D:\\'],
    ['/mnt/c/repo/../preview.html', 'C:\\preview.html'],
    ['/mnt/c/../d/preview.html', 'D:\\preview.html'],
    ['/mnt/c/../../home/me/preview.html', '/mnt/c/../../home/me/preview.html'],
    ['/home/me/preview.html', '/home/me/preview.html'],
  ])('resolves %s according to Linux path semantics', (input, expected) => {
    expect(wslMountToWindowsPath(input)).toBe(expected);
  });
});

describe('getWSLShellSpawn', () => {
  it.each([
    ['/home/me/a$b', "cd '/home/me/a$b' && exec bash --login"],
    ['/home/me/it\'s', "cd '/home/me/it'\\''s' && exec bash --login"],
    ['/home/me/say "hi"', "cd '/home/me/say \"hi\"' && exec bash --login"],
    ['/home/me/back\\slash', "cd '/home/me/back\\slash' && exec bash --login"],
    ['/home/me/`tick`', "cd '/home/me/`tick`' && exec bash --login"],
  ])('runs bash directly and single-quotes %s', (cwd, script) => {
    expect(getWSLShellSpawn('Ubuntu', cwd).args).toEqual(['-d', 'Ubuntu', '--exec', 'bash', '-c', script]);
  });
});

describe('validateWSLAvailable', () => {
  function fakeWsl(listOutput: Buffer) {
    return async (args: string[]) => (args[0] === '-l' ? listOutput : Buffer.alloc(0));
  }

  // What `wsl.exe -l -q` writes by default: BOM, then UTF-16LE lines ending in CRLF.
  const utf16List = Buffer.from([
    0xff, 0xfe,
    0x55, 0x00, 0x62, 0x00, 0x75, 0x00, 0x6e, 0x00, 0x74, 0x00, 0x75, 0x00, 0x0d, 0x00, 0x0a, 0x00, // Ubuntu\r\n
    0x44, 0x00, 0xe9, 0x00, 0x62, 0x00, 0x69, 0x00, 0x61, 0x00, 0x6e, 0x00, 0x0d, 0x00, 0x0a, 0x00, // Débian\r\n
  ]);

  it('finds a non-ASCII distro in UTF-16LE output', async () => {
    await expect(validateWSLAvailable('débian', fakeWsl(utf16List))).resolves.toBeNull();
  });

  it('lists the decoded distros when the requested one is missing', async () => {
    await expect(validateWSLAvailable('Arch', fakeWsl(utf16List))).resolves.toBe(
      "WSL distribution 'Arch' is not installed. Available: Ubuntu, Débian"
    );
  });

  it('reads UTF-8 output when WSL_UTF8 is set', async () => {
    const utf8List = Buffer.from('Ubuntu\nDébian\n', 'utf8');
    await expect(validateWSLAvailable('Débian', fakeWsl(utf8List))).resolves.toBeNull();
  });
});

describe('getDefaultWSLDistribution', () => {
  // What `wsl.exe -l -v` writes: UTF-16LE, the default distribution marked with "*".
  const verbose = Buffer.from('﻿  NAME      STATE           VERSION\r\n  Debian    Stopped         2\r\n* Ubuntu    Running         2\r\n', 'utf16le');

  it('returns the distribution marked as default', async () => {
    await expect(getDefaultWSLDistribution(async () => verbose)).resolves.toBe('Ubuntu');
  });

  it('returns undefined when WSL is missing', async () => {
    await expect(getDefaultWSLDistribution(async () => { throw new Error('wsl.exe not found'); })).resolves.toBeUndefined();
  });
});
