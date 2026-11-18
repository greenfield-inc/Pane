import { describe, expect, it } from 'vitest';
import { OnePassword, type OpRunner } from './onePassword';

/** Answers `op inject` the way op does: each {{ reference }} replaced by its value, the rest of the template kept. */
function injecting(values: Record<string, string>) {
  const stdins: string[] = [];
  return {
    stdins,
    run: async (_args: readonly string[], stdin: string) => {
      stdins.push(stdin);
      return { code: 0, stdout: stdin.replace(/\{\{ (op:\/\/[^}]+) \}\}/g, (_match, reference: string) => values[reference]), stderr: '' };
    },
  };
}

describe('OnePassword', () => {
  it('reads several references in one op call, keeping line breaks and template-like text inside values', async () => {
    const op = injecting({ 'op://Dev/Key/credential': 'line one\nline two\n', 'op://Dev/Odd/credential': ':pane-like: {{ not a reference }}' });

    const values = await new OnePassword(op.run).read(['op://Dev/Key/credential', 'op://Dev/Odd/credential']);

    expect(values).toEqual(['line one\nline two\n', ':pane-like: {{ not a reference }}']);
    expect(op.stdins).toHaveLength(1);
  });

  it('turns a dismissed approval into a next step, with op\'s reason and no value', async () => {
    const run: OpRunner = async () => ({ code: 1, stdout: '', stderr: '[ERROR] 2026/11/18 12:00:00 authorization prompt dismissed, please try again\n' });

    await expect(new OnePassword(run).read(['op://Dev/Key/credential'])).rejects.toMatchObject({
      code: 'ONEPASSWORD_NOT_APPROVED',
      message: '1Password did not allow Pane to read op://Dev/Key/credential: authorization prompt dismissed, please try again. Nothing was read.',
    });
  });

  it('creates an item from a template on stdin and returns a reference by vault and item id', async () => {
    const calls: Array<{ args: readonly string[]; stdin: string }> = [];
    const run: OpRunner = async (args, stdin) => {
      calls.push({ args, stdin });
      return { code: 0, stdout: JSON.stringify({ id: 'itemid123', vault: { id: 'vaultid456', name: 'Dev' } }), stderr: '' };
    };

    const reference = await new OnePassword(run).createItem('Dev', 'stripe/STRIPE_KEY (Pane)', 'canary-value');

    expect(reference).toBe('op://vaultid456/itemid123/credential');
    expect(calls[0].args).not.toContain('canary-value');
    expect(JSON.parse(calls[0].stdin).fields[0]).toMatchObject({ id: 'credential', type: 'CONCEALED', value: 'canary-value' });
  });
});
