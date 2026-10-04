import { format } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadFresh() {
  vi.resetModules();
  return import('./deliveredSecrets');
}

describe('redactDeliveredSecrets', () => {
  it('leaves text unchanged when nothing has been delivered', async () => {
    const { redactDeliveredSecrets } = await loadFresh();

    expect(redactDeliveredSecrets('OPENAI_API_KEY=sk-canary-0001')).toBe('OPENAI_API_KEY=sk-canary-0001');
  });

  it('replaces every occurrence of a delivered value', async () => {
    const { registerDeliveredSecrets, redactDeliveredSecrets } = await loadFresh();
    registerDeliveredSecrets(['sk-canary-0001']);

    expect(redactDeliveredSecrets('env {"OPENAI_API_KEY":"sk-canary-0001"} again sk-canary-0001'))
      .toBe('env {"OPENAI_API_KEY":"[redacted]"} again [redacted]');
  });

  it('redacts the longer of two overlapping values whole', async () => {
    const { registerDeliveredSecrets, redactDeliveredSecrets } = await loadFresh();
    registerDeliveredSecrets(['canary-value', 'canary-value-extended']);

    expect(redactDeliveredSecrets('x canary-value-extended y')).toBe('x [redacted] y');
  });

  it('ignores values too short to be secrets', async () => {
    const { registerDeliveredSecrets, redactDeliveredSecrets } = await loadFresh();
    registerDeliveredSecrets(['true', '3000', '']);

    expect(redactDeliveredSecrets('PANE_PORT=3000 enabled=true')).toBe('PANE_PORT=3000 enabled=true');
  });

  it('redacts a multi-line value after JSON or inspect escaping', async () => {
    const { registerDeliveredSecrets, redactDeliveredSecrets } = await loadFresh();
    const pem = '-----BEGIN CANARY KEY-----\nMIIEcanaryline1\n"quoted-canary"\n-----END CANARY KEY-----';
    registerDeliveredSecrets([pem]);

    expect(redactDeliveredSecrets(JSON.stringify({ KEY: pem }))).not.toContain('canary');
    expect(redactDeliveredSecrets(format({ KEY: pem }))).not.toContain('canary');
  });
});

describe('redactProcessOutput', () => {
  const originalWrites = { stdout: process.stdout.write, stderr: process.stderr.write };

  afterEach(() => {
    process.stdout.write = originalWrites.stdout;
    process.stderr.write = originalWrites.stderr;
  });

  it('redacts delivered values written to stdout and stderr', async () => {
    const written: string[] = [];
    const capture = (chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    };
    process.stdout.write = capture;
    process.stderr.write = capture;
    const { registerDeliveredSecrets, redactProcessOutput } = await loadFresh();
    registerDeliveredSecrets(['sk-canary-0001']);

    redactProcessOutput();
    process.stdout.write('[ptyHost] spawn failed: env sk-canary-0001\n');
    process.stderr.write(Buffer.from('OPENAI_API_KEY=sk-canary-0001\n'));

    expect(written).toEqual(['[ptyHost] spawn failed: env [redacted]\n', 'OPENAI_API_KEY=[redacted]\n']);
  });
});
