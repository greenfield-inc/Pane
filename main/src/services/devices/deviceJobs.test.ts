import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DeviceJobs } from './deviceJobs';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('DeviceJobs', () => {
  const jobs = new DeviceJobs({ shell: () => ({ executable: '/bin/sh', args: command => ['-c', command] }) });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'device-jobs-'));

  afterEach(async () => {
    await jobs.stopAll('pane-a');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reports a command that finishes with its exit code and output', async () => {
    const result = await jobs.start('pane-a', 'echo build ok; echo warning >&2; exit 3', dir, 10_000);
    expect(result.state).toBe('exited');
    expect(result.exitCode).toBe(3);
    expect(result.logTail).toContain('build ok');
    expect(result.logTail).toContain('warning');
  });

  it('marks a log tail whose earlier output was cut', async () => {
    const result = await jobs.start('pane-a', 'echo first line; i=0; while [ $i -lt 2000 ]; do echo "compiling module $i of the app"; i=$((i+1)); done; echo last line', dir, 10_000);
    expect(result.logTail.startsWith('[earlier output cut]\n')).toBe(true);
    expect(result.logTail).not.toContain('first line');
    expect(result.logTail.endsWith('last line\n')).toBe(true);
  });

  it('leaves a long command running, and stopAll ends it', async () => {
    const pidFile = path.join(dir, 'pid');
    const started = await jobs.start('pane-a', `echo $$ > "${pidFile}"; echo metro up; sleep 30`, dir, 500);
    expect(started.state).toBe('running');
    expect(started.logTail).toContain('metro up');
    expect(jobs.running('pane-a').map(job => job.jobId)).toEqual([started.jobId]);
    expect(jobs.running('pane-b')).toEqual([]);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(isAlive(pid)).toBe(true);

    expect(await jobs.stopAll('pane-a')).toBe(1);
    expect(isAlive(pid)).toBe(false);
    expect(jobs.running('pane-a')).toEqual([]);
    await expect(jobs.wait('pane-a', started.jobId, 0)).rejects.toThrow('No device job');
  });

  it('keeps one Pane from reading another Pane\'s job', async () => {
    const started = await jobs.start('pane-a', 'sleep 30', dir, 0);
    await expect(jobs.wait('pane-b', started.jobId, 0)).rejects.toThrow('No device job');
  });
});
