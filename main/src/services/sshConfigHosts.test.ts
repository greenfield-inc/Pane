import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listSshConfigHosts } from './sshConfigHosts';

const homes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});

/** A throwaway home directory holding the given files under `.ssh/`. */
async function homeWith(files: Record<string, string>): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-ssh-home-'));
  homes.push(home);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(home, '.ssh', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return home;
}

describe('listSshConfigHosts', () => {
  it('lists concrete aliases in the order ssh reads them, following Include and skipping patterns', async () => {
    const home = await homeWith({
      config: [
        '# personal machines',
        'Include conf.d/*',
        'Host mini',
        '  HostName 100.64.0.7',
        '  IdentityFile ~/.ssh/id_mini',
        'Host a b',
        'Host *',
        '  ServerAliveInterval 30',
        'Host *.internal',
        'Host !c',
      ].join('\n'),
      'conf.d/web': 'Host web-1\n  User deploy\n',
    });

    expect(await listSshConfigHosts(home)).toEqual(['web-1', 'mini', 'a', 'b']);
  });

  it('accepts any keyword case, Host=alias syntax, quoted values, comments, tabs and CRLF line endings', async () => {
    const home = await homeWith({
      config: [
        'Include "extra"',
        'HOST one',
        'host=two',
        'Host = three',
        '\tHost\t"four"',
        'Host five # a trailing comment',
      ].join('\r\n'),
      extra: 'host six\r\n',
    });

    expect(await listSshConfigHosts(home)).toEqual(['six', 'one', 'two', 'three', 'four', 'five']);
  });

  it('skips aliases that a shell would interpret and keeps the safe character set', async () => {
    const home = await homeWith({
      config: [
        'Host ok-1 user@box.example:22 under_score _lead 9lives',
        'Host bad;rm $(touch) `x` it\'s "two words" a|b',
        // A leading - reads as an ssh option; a leading @ splats a variable in PowerShell.
        'Host -V -oProxyCommand=x @prod .dot :colon',
        'Host fine',
      ].join('\n'),
    });

    expect(await listSshConfigHosts(home)).toEqual(['ok-1', 'user@box.example:22', 'under_score', '_lead', '9lives', 'fine']);
  });

  it('lists each alias once even when it appears again', async () => {
    const home = await homeWith({
      config: 'Include dup\nHost mini\nHost mini web\n',
      dup: 'Host web mini\n',
    });

    expect(await listSshConfigHosts(home)).toEqual(['web', 'mini']);
  });

  it('follows only Includes that apply to every host, as ssh skips the rest', async () => {
    const home = await homeWith({
      config: [
        'Include top',
        'Host *',
        '  Include for-all',
        'Host gate',
        '  Include only-for-gate',
        'Match host matched-only',
        '  Include only-for-match',
      ].join('\n'),
      top: 'Include nested\nHost from-top\n',
      nested: 'Host from-nested\n',
      'for-all': 'Host from-star\n',
      'only-for-gate': 'Host behind-gate\n',
      'only-for-match': 'Host behind-match\n',
    });

    expect(await listSshConfigHosts(home)).toEqual(['from-nested', 'from-top', 'from-star', 'gate']);
  });

  it('expands Include globs in lexical order and resolves ~ and absolute paths', async () => {
    const home = await homeWith({
      'conf.d/b.conf': 'Host second\n',
      'conf.d/a.conf': 'Host first\n',
      'conf.d/notes.txt': 'Host not-included\n',
      'tilde/home': 'Host tilde\n',
      absolute: 'Host absolute\n',
    });
    await fs.writeFile(path.join(home, '.ssh', 'config'), [
      'Include conf.d/*.conf ~/.ssh/tilde/home',
      `Include ${path.join(home, '.ssh', 'absolute')}`,
      'Include missing/* nothing-here',
    ].join('\n'));

    expect(await listSshConfigHosts(home)).toEqual(['first', 'second', 'tilde', 'absolute']);
  });

  it('stops at an Include cycle', async () => {
    const home = await homeWith({
      config: 'Include loop-a\nHost top\n',
      'loop-a': 'Include loop-b\nHost in-a\n',
      'loop-b': 'Include loop-a config\nHost in-b\n',
    });

    expect(await listSshConfigHosts(home)).toEqual(['in-b', 'in-a', 'top']);
  });

  it('skips malformed lines and keeps listing', async () => {
    const home = await homeWith({
      config: 'Host before\nHost\n"unterminated quote\n===\nInclude\nHost after\n',
    });

    expect(await listSshConfigHosts(home)).toEqual(['before', 'after']);
  });

  it('returns an empty list without a config file', async () => {
    const home = await homeWith({});

    expect(await listSshConfigHosts(home)).toEqual([]);
  });

  it('opens only the config and its Included files, never an IdentityFile', async () => {
    const home = await homeWith({
      config: 'Include conf.d/*\nHost mini\n  IdentityFile ~/.ssh/id_mini\n  CertificateFile ~/.ssh/id_mini-cert.pub\n',
      'conf.d/web': 'Host web-1\n  IdentityFile ~/.ssh/id_web\n',
      id_mini: 'PRIVATE KEY',
      'id_mini-cert.pub': 'CERT',
      id_web: 'PRIVATE KEY',
    });
    const readFile = vi.spyOn(fs, 'readFile');

    await listSshConfigHosts(home);

    const opened = readFile.mock.calls.map(([file]) => path.relative(path.join(home, '.ssh'), String(file)));
    expect(opened.sort()).toEqual(['conf.d/web', 'config'].map((name) => path.normalize(name)));
  });

  it.runIf(process.platform === 'win32')('resolves Windows-style Include paths', async () => {
    const home = await homeWith({
      'conf.d/win': 'Host win-relative\n',
      'abs/win': 'Host win-absolute\n',
    });
    await fs.writeFile(path.join(home, '.ssh', 'config'), [
      'Include conf.d\\*',
      `Include ${path.join(home, '.ssh', 'abs', 'win')}`,
    ].join('\r\n'));

    expect(await listSshConfigHosts(home)).toEqual(['win-relative', 'win-absolute']);
  });
});
