import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CANARY = 'sk-pane-vault-canary-7f3a91';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Logger', () => {
  it('never writes a delivered value to the log file or console', async () => {
    const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-logger-'));
    vi.stubEnv('PANE_DIR', paneDir);
    const consoleLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      consoleLines.push(line);
    });
    // Logger captures console at module load, so load it after the spy.
    vi.resetModules();
    const { registerDeliveredSecrets } = await import('./deliveredSecrets');
    const { Logger } = await import('./logger');
    registerDeliveredSecrets([CANARY]);

    const logger = new Logger({ isVerbose: () => true });
    logger.info(`[Terminal] spawn env {"OPENAI_API_KEY":"${CANARY}"}`);
    logger.verbose(`[Terminal] OPENAI_API_KEY=${CANARY}`);
    logger.error('[ptyHost] spawn failed', new Error(`bad env value ${CANARY}`));

    const logDir = path.join(paneDir, 'logs');
    await vi.waitFor(() => {
      const [file] = fs.readdirSync(logDir);
      expect(fs.readFileSync(path.join(logDir, file), 'utf8')).toContain('bad env value');
    });
    logger.close();

    const [file] = fs.readdirSync(logDir);
    const written = fs.readFileSync(path.join(logDir, file), 'utf8');
    expect(written).toContain('OPENAI_API_KEY=[redacted]');
    expect(written).not.toContain(CANARY);
    expect(consoleLines.join('\n')).not.toContain(CANARY);
    fs.rmSync(paneDir, { recursive: true, force: true });
  });
});
