import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertUpdateQuiescence, claimUpdateLock, releaseUpdateLock, executeUpdate, readUpdateJournal, writeUpdateJson } from '../../../packages/runpane/src/updateOperation';

const directories: string[] = [];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-update-test-'));
  directories.push(directory);
  const file = path.join(directory, 'status.json');
  writeUpdateJson(file, { id: 'test', host: 'isolated', scope: 'both', version: '2.4.182', phase: 'accepted', completed: [], updatedAt: new Date().toISOString(), appUpdated: false, cliUpdated: false, hostReachable: false, restored: [] });
  return { directory, file };
}
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
describe('durable update operation', () => {
  it('refuses replacement after a forced exit or another boot’s shutdown acknowledgment', () => {
    const { directory } = fixture();
    const expected = { id: 'op', bootId: 'boot', pid: 123 };
    expect(() => assertUpdateQuiescence(directory, expected)).toThrow('without acknowledging clean shutdown');
    writeUpdateJson(path.join(directory, 'quiesced.json'), { ...expected, bootId: 'old' });
    expect(() => assertUpdateQuiescence(directory, expected)).toThrow('another operation or host');
    writeUpdateJson(path.join(directory, 'quiesced.json'), expected);
    expect(() => assertUpdateQuiescence(directory, expected)).not.toThrow();
  });
  it('acknowledges the independent helper before staging and never stops after staging fails', async () => {
    const { file } = fixture();
    const seen: string[] = [];
    const result = await executeUpdate(file, { run: async step => {
      expect(readUpdateJournal(file).helperPid).toBe(process.pid);
      seen.push(step);
      throw new Error('signature mismatch');
    } });
    expect(seen).toEqual(['stage']);
    expect(result.phase).toBe('failed');
    expect(result.appUpdated).toBe(false);
  });
  it('keeps a post-shutdown failure inspectable without rolling data back', async () => {
    const { file } = fixture();
    const result = await executeUpdate(file, { run: async step => {
      if (step === 'health') throw new Error('new daemon is unreachable');
      return step === 'install' ? { appUpdated: true } : {};
    } });
    expect(result.phase).toBe('needs-attention');
    expect(result.appUpdated).toBe(true);
    expect(result.hostReachable).toBe(false);
  });
  it('resumes an interrupted operation without repeating completed effects', async () => {
    const { file } = fixture();
    writeUpdateJson(file, { ...readUpdateJournal(file), completed: ['stage', 'checkpoint', 'stop', 'snapshot', 'install'], phase: 'launch' });
    const seen: string[] = [];
    await executeUpdate(file, { run: async step => { seen.push(step); return {}; } });
    expect(seen).toEqual(['launch', 'health', 'restore']);
  });
  it('returns the existing operation when a second caller claims the host', () => {
    const { file, directory } = fixture();
    const lock = path.join(directory, 'lock');
    expect(claimUpdateLock(lock, 'first', file).acquired).toBe(true);
    expect(claimUpdateLock(lock, 'second', 'different')).toEqual({ id: 'first', statusFile: file, acquired: false });
  });
  it('never releases a newer operation when an old helper exits twice', () => {
    const { file, directory } = fixture();
    const lock = path.join(directory, 'lock');
    claimUpdateLock(lock, 'first', file);
    releaseUpdateLock(lock, 'first');
    claimUpdateLock(lock, 'second', file);
    releaseUpdateLock(lock, 'first');
    expect(claimUpdateLock(lock, 'third', file)).toMatchObject({ acquired: false, id: 'second' });
  });
  it('lets a new update claim the host after a needs-attention operation', () => {
    const { file, directory } = fixture();
    writeUpdateJson(file, { ...readUpdateJournal(file), id: 'first', phase: 'needs-attention' });
    const lock = path.join(directory, 'lock');
    claimUpdateLock(lock, 'first', file);
    expect(claimUpdateLock(lock, 'next', 'next-status')).toEqual({ id: 'next', statusFile: 'next-status', acquired: true });
  });
  it('repairs cleanup after the terminal journal committed and its releaser died', () => {
    const { file, directory } = fixture();
    writeUpdateJson(file, { ...readUpdateJournal(file), id: 'first', phase: 'complete' });
    const lock = path.join(directory, 'lock');
    claimUpdateLock(lock, 'first', file);
    writeUpdateJson(path.join(lock, 'releasing'), { id: 'first', pid: 999999999 });
    expect(claimUpdateLock(lock, 'next', file)).toMatchObject({ acquired: true, id: 'next' });
  });
  it('preserves ownership when a cleanup recovery itself was interrupted', () => {
    const { file, directory } = fixture();
    writeUpdateJson(file, { ...readUpdateJournal(file), id: 'first', phase: 'complete' });
    const lock = path.join(directory, 'lock');
    claimUpdateLock(lock, 'first', file);
    const marker = path.join(lock, 'releasing');
    writeUpdateJson(marker, { id: 'first', pid: 999999999 });
    const unlink = fs.unlinkSync;
    const interruption = vi.spyOn(fs, 'unlinkSync').mockImplementation(target => {
      if (target === marker) throw new Error('Cleanup interrupted after its exclusive recovery claim');
      unlink(target);
    });
    releaseUpdateLock(lock, 'first');
    interruption.mockRestore();
    expect(() => claimUpdateLock(lock, 'next', file)).toThrow(expect.objectContaining({ code: 'ERR_UPDATE_LOCK_RECOVERY' }));
    expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).id).toBe('first');
    expect(fs.existsSync(marker)).toBe(true);
  });
  it('reports an incomplete legacy cleanup marker instead of claiming a completed update again', () => {
    const { file, directory } = fixture();
    writeUpdateJson(file, { ...readUpdateJournal(file), id: 'first', phase: 'complete' });
    const lock = path.join(directory, 'lock');
    claimUpdateLock(lock, 'first', file);
    fs.writeFileSync(path.join(lock, 'releasing'), '');
    expect(() => claimUpdateLock(lock, 'next', file)).toThrow(expect.objectContaining({ code: 'ERR_UPDATE_LOCK_RECOVERY' }));
    expect(fs.existsSync(lock)).toBe(true);
  });
  it('cancels an expired setup from a dead caller before a late helper can run', async () => {
    const { file, directory } = fixture();
    writeUpdateJson(file, { ...readUpdateJournal(file), id: 'first', setupPid: 999999999, setupExpiresAt: 1 });
    const lock = path.join(directory, 'lock');
    claimUpdateLock(lock, 'first', file);
    expect(claimUpdateLock(lock, 'next', file)).toMatchObject({ acquired: true });
    const run = async () => { throw new Error('must never run'); };
    expect((await executeUpdate(file, { run })).phase).toBe('failed');
    expect(fs.existsSync(path.join(directory, 'canceled.json'))).toBe(true);
  });

  it('honors caller failure before the helper can shut down Pane', async () => {
    const { file } = fixture();
    const seen: string[] = [];
    const result = await executeUpdate(file, { run: async step => {
      seen.push(step);
      writeUpdateJson(file, { ...readUpdateJournal(file), phase: 'failed', error: 'Caller canceled queued supervisor' });
      return {};
    } });
    expect(seen).toEqual(['stage']);
    expect(result.phase).toBe('failed');
  });
  it('honors immutable handoff cancellation even if a concurrent acknowledgment overwrites the journal', async () => {
    const { file, directory } = fixture();
    const seen: string[] = [];
    const result = await executeUpdate(file, { run: async step => {
      seen.push(step);
      if (step === 'stage') {
        writeUpdateJson(path.join(directory, 'canceled.json'), { id: 'test', reason: 'Supervisor startup timed out' });
        writeUpdateJson(file, { ...readUpdateJournal(file), phase: 'accepted' });
      }
      return {};
    } });
    expect(result.phase).toBe('failed');
    expect(seen).toEqual(['stage']);
    expect(result.appUpdated).toBe(false);
  });

});
