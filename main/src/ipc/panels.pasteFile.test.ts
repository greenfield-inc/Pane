import fs from 'fs/promises';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerPanelHandlers } from './panels';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: Each fixture supplies every member read by the tested code.
  return value as Contract;
}

const dataUrl = (text: string) => `data:text/plain;base64,${Buffer.from(text).toString('base64')}`;
const savedPath = async (reply: Promise<unknown>) => decodeBoundary(await reply, boundary.object({ filePath: boundary.nonEmptyString })).filePath;

// D-162: a file dropped into a chat keeps its own name on the host; the terminal's
// uploads keep their generated names. PANE_DIR is a temp folder (src/test/setup.ts).
describe('terminal:paste-file', () => {
  let registry: PaneCommandRegistry;
  const sessionId = 'paste-file-session';

  beforeEach(() => {
    registry = new PaneCommandRegistry();
    // SAFETY: No service is read while saving a file outside WSL.
    registerPanelHandlers(partial<IpcMain>({ handle: vi.fn() }), {} as AppServices, registry);
  });

  it('keeps a chat attachment\'s own name, in a folder of its own', async () => {
    const file = await savedPath(registry.invokeRemote('terminal:paste-file', [sessionId, dataUrl('report'), 'Quarterly report (final).pdf', { keepName: true }]));
    expect(path.basename(file)).toBe('Quarterly report (final).pdf');
    expect(await fs.readFile(file, 'utf8')).toBe('report');
  });

  it('keeps two files with one name apart, and never writes outside the files folder', async () => {
    const first = await savedPath(registry.invokeRemote('terminal:paste-file', [sessionId, dataUrl('one'), 'notes.txt', { keepName: true }]));
    const second = await savedPath(registry.invokeRemote('terminal:paste-file', [sessionId, dataUrl('two'), 'notes.txt', { keepName: true }]));
    expect(first).not.toBe(second);
    expect([path.basename(first), path.basename(second)]).toEqual(['notes.txt', 'notes.txt']);
    expect(await fs.readFile(first, 'utf8')).toBe('one');
    const escaped = await savedPath(registry.invokeRemote('terminal:paste-file', [sessionId, dataUrl('x'), '../../escape.txt', { keepName: true }]));
    expect(path.basename(escaped)).toBe('escape.txt');
    expect(escaped.startsWith(path.join(process.env.PANE_DIR!, 'files'))).toBe(true);
  });

  it('still names the terminal\'s uploads itself', async () => {
    const file = await savedPath(registry.invokeRemote('terminal:paste-file', [sessionId, dataUrl('log'), 'server.log']));
    expect(path.basename(file)).toMatch(new RegExp(`^${sessionId}_\\d+_[a-z0-9]+\\.log$`));
  });
});
