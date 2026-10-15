import { describe, expect, it } from 'vitest';
import { macKeychain, paneKeychainService, parseSecurityPassword, systemKeychain, type SecurityRunner } from './keychain';

describe('macOS keychain', () => {
  it('reads plain and hex-encoded passwords from security output', () => {
    expect(parseSecurityPassword('keychain: "login"\npassword: "sk-live-123"\n')).toBe('sk-live-123');
    expect(parseSecurityPassword('password: 0x7122756F5C7465  "q"uo\\134te"\n')).toBe('q"uo\\te');
    expect(parseSecurityPassword('password: 0x610A62C3A9  "a\\012b\\303\\251"\n')).toBe('a\nbé');
    expect(parseSecurityPassword('security: The specified item could not be found in the keychain.\n')).toBeNull();
  });

  it('writes a secret through stdin, never as a command-line argument', async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const run: SecurityRunner = async (args, stdin) => {
      calls.push({ args, stdin });
      return { code: 0, stdout: '', stderr: '' };
    };

    await macKeychain(run).write('Pane', '2:UIVERIFY_API_KEY', 'sk "live"');

    expect(calls).toHaveLength(1);
    expect(calls[0].args.join(' ')).not.toContain('sk');
    expect(calls[0].stdin).toBe(`add-generic-password -U -s "Pane" -a "2:UIVERIFY_API_KEY" -X ${Buffer.from('sk "live"').toString('hex')}\n`);
  });

  it('reports the keychain\'s reason when a read fails', async () => {
    const run: SecurityRunner = async () => ({
      code: 44,
      stdout: '',
      stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
    });

    await expect(macKeychain(run).read('Pane', '2:X')).rejects.toThrow('The specified item could not be found in the keychain.');
  });

  it('refuses every operation off macOS', async () => {
    const keychain = systemKeychain('linux');
    expect(keychain.supported).toBe(false);
    await expect(keychain.read('Pane', 'x')).rejects.toMatchObject({ code: 'KEYCHAIN_UNSUPPORTED' });
    await expect(keychain.write('Pane', 'x', 'y')).rejects.toThrow(/only on macOS.*linux/);
  });
});

describe('Pane keychain service name', () => {
  it('is "Pane" for the default data directory and names any other one', () => {
    expect(paneKeychainService('/Users/me/.pane', '/Users/me')).toBe('Pane');
    expect(paneKeychainService('/Users/me/.pane_test', '/Users/me')).toBe('Pane (/Users/me/.pane_test)');
  });
});
