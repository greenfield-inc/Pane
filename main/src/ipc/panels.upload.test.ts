import fs from 'fs/promises';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerPanelHandlers } from './panels';
import { uploadInChunks, UploadRefusedError, type UploadFile } from '../../../shared/chunkedUpload';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: Each fixture supplies every member read by the tested code.
  return value as Contract;
}

function memoryFile(name: string, content: string, mimeType = 'text/plain'): UploadFile {
  return {
    name,
    mimeType,
    size: content.length,
    md5: '',
    read: async (offset, length) => Buffer.from(content.slice(offset, offset + length)).toString('base64'),
  };
}

const noWait = async () => undefined;

// The shared client loop against the host's real upload handlers, as a phone or a desktop
// connected over the network reaches them. PANE_DIR is a temp folder (src/test/setup.ts).
describe('chunked upload to the real host handlers', () => {
  // Machine health's critical level, which every upload must leave free. The store reads it per call.
  const config = { machineHealth: { diskCriticalGB: 0 } };
  let registry: PaneCommandRegistry;
  let calls: string[];
  let uploadNumber = 0;
  /** One per test, so a test can count the files its uploads landed. */
  const sessionId = () => `upload-session-${uploadNumber}`;

  /** The registry as the network reaches it; `lose` drops the reply to one call (the nth on its channel), after the host acted. */
  const invoke = (lose?: { channel: string; nth: number }) => async (channel: string, args: JsonValue[]) => {
    calls.push(channel);
    const reply = await registry.invokeRemote(channel, args);
    if (lose?.channel === channel && calls.filter(called => called === channel).length === lose.nth) throw new Error('Network request failed');
    return reply;
  };

  beforeEach(() => {
    config.machineHealth.diskCriticalGB = 0;
    calls = [];
    uploadNumber += 1;
    registry = new PaneCommandRegistry();
    registerPanelHandlers(partial<IpcMain>({ handle: vi.fn() }), partial<AppServices>({
      configManager: partial<AppServices['configManager']>({ getConfig: () => partial({ machineHealth: config.machineHealth }) }),
    }), registry);
  });

  const upload = (file: UploadFile, options: { keepName?: boolean; lose?: { channel: string; nth: number } } = {}) => uploadInChunks({
    invoke: invoke(options.lose), file, sessionId: sessionId(), uploadId: `upload-test-${uploadNumber}`, keepName: options.keepName, chunkBytes: 4, wait: noWait,
  });

  it('lands a chat attachment under its own name', async () => {
    const landed = await upload(memoryFile('Quarterly report.pdf', 'the report'), { keepName: true });

    expect(path.basename(landed)).toBe('Quarterly report.pdf');
    expect(await fs.readFile(landed, 'utf8')).toBe('the report');
  });

  it('resumes after a lost chunk reply without sending a byte twice', async () => {
    // The host keeps the second chunk, its reply is lost, and the client asks where to resume.
    const landed = await upload(memoryFile('notes.txt', 'hello wonderful world'), { lose: { channel: 'terminal:upload-chunk', nth: 2 } });

    expect(await fs.readFile(landed, 'utf8')).toBe('hello wonderful world');
    expect(calls.slice(0, 4)).toEqual(['terminal:upload-start', 'terminal:upload-chunk', 'terminal:upload-chunk', 'terminal:upload-start']);
  });

  it('lands the file once when the commit reply is lost', async () => {
    const landed = await upload(memoryFile('once.txt', 'twelve bytes'), { lose: { channel: 'terminal:upload-commit', nth: 1 } });

    expect(calls.slice(-3)).toEqual(['terminal:upload-commit', 'terminal:upload-start', 'terminal:upload-commit']);
    expect(await fs.readFile(landed, 'utf8')).toBe('twelve bytes');
    // The second commit answered with the first one's path: one file landed.
    const files = await fs.readdir(path.dirname(landed));
    expect(files.filter(name => name.startsWith(`${sessionId()}_`))).toEqual([path.basename(landed)]);
  });

  it('refuses a file the host has no room for, and the client stops', async () => {
    // No disk has a petabyte free.
    config.machineHealth.diskCriticalGB = 1024 ** 2;

    await expect(upload(memoryFile('big.mov', 'video', 'video/quicktime'))).rejects.toBeInstanceOf(UploadRefusedError);
    expect(calls).toEqual(['terminal:upload-start']);
  });
});
