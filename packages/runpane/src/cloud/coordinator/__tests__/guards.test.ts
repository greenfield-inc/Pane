import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { RunawayGuard } from '../guards';
import type { ProviderSandbox } from '../types';
import { FakeClock, sandbox } from './fakes';

const LIMITS = { maxLiveSandboxes: 25, maxResumesPerSandboxPerHour: 1, maxResumesPerHour: 60 };

function historyFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-guard-')), 'state', 'resumes.json');
}

/** A provider resume the test counts, and can hold open until `release`. */
function resumeSteps(managed: ProviderSandbox[] = [sandbox('bx_a', 'stopped')]) {
  const calls: string[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    calls,
    release: () => release(),
    steps: (options: { hold?: boolean; fail?: Error } = {}) => ({
      listManaged: async () => managed,
      resume: async () => {
        calls.push('resume');
        if (options.hold) await held;
        if (options.fail) throw options.fail;
      },
    }),
  };
}

describe('RunawayGuard resume history', () => {
  it('is shared through its file, so a second process (coordinator wake --local) sees the first one\'s resume', async () => {
    const clock = new FakeClock();
    const file = historyFile();
    const service = new RunawayGuard(clock, LIMITS, file);
    const cli = new RunawayGuard(clock, LIMITS, file);
    const provider = resumeSteps();

    assert.deepEqual(await cli.resumeWithinCaps('bx_a', provider.steps()), { ok: true });
    const verdict = await service.resumeWithinCaps('bx_a', provider.steps());
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok ? '' : verdict.code, 'wake-rate-limited');
    assert.deepEqual(provider.calls, ['resume']);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    clock.time += 3_601_000;
    assert.deepEqual(await new RunawayGuard(clock, LIMITS, file).resumeWithinCaps('bx_a', provider.steps()), { ok: true });
  });

  it('lets only one of two processes resume past a cap, even when both checked before either resumed', async () => {
    const clock = new FakeClock();
    const file = historyFile();
    const service = new RunawayGuard(clock, LIMITS, file);
    const cli = new RunawayGuard(clock, LIMITS, file);
    const provider = resumeSteps();

    const first = service.resumeWithinCaps('bx_a', provider.steps({ hold: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = cli.resumeWithinCaps('bx_a', provider.steps());
    await new Promise((resolve) => setTimeout(resolve, 20));
    provider.release();

    assert.deepEqual(await first, { ok: true });
    const verdict = await second;
    assert.equal(verdict.ok ? '' : verdict.code, 'wake-rate-limited');
    assert.deepEqual(provider.calls, ['resume']);
    assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is released');
  });

  it('records only a resume that succeeded, and releases the lock when it fails', async () => {
    const clock = new FakeClock();
    const file = historyFile();
    const guard = new RunawayGuard(clock, LIMITS, file);
    const provider = resumeSteps();

    await assert.rejects(guard.resumeWithinCaps('bx_a', provider.steps({ fail: new Error('HTTP 500') })), /HTTP 500/);
    assert.equal(fs.existsSync(`${file}.lock`), false);
    assert.deepEqual(await guard.resumeWithinCaps('bx_a', provider.steps()), { ok: true });
    assert.equal(provider.calls.length, 2);
  });

  it('treats a missing history as empty', async () => {
    const guard = new RunawayGuard(new FakeClock(), LIMITS, historyFile());
    assert.deepEqual(await guard.resumeWithinCaps('bx_a', resumeSteps().steps()), { ok: true });
  });

  it('fails closed on an unreadable or invalid history, and leaves it for repair', async () => {
    for (const contents of ['{not json', '{"sandboxId":"bx_a"}', '[{"sandboxId":"bx_a","at":"yesterday"}]']) {
      const file = historyFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
      const provider = resumeSteps();
      const verdict = await new RunawayGuard(new FakeClock(), LIMITS, file).resumeWithinCaps('bx_a', provider.steps());
      assert.equal(verdict.ok ? '' : verdict.code, 'resume-history-invalid', contents);
      assert.deepEqual(provider.calls, []);
      assert.equal(fs.readFileSync(file, 'utf8'), contents);
    }
  });

  it('refuses to resume while another live process holds the lock', async () => {
    const clock = new FakeClock();
    const file = historyFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const provider = resumeSteps();
    const verdict = await new RunawayGuard(clock, LIMITS, file, 200).resumeWithinCaps('bx_a', provider.steps());
    assert.equal(verdict.ok ? '' : verdict.code, 'resume-history-busy');
    assert.deepEqual(provider.calls, []);
  });

  it('breaks a lock left by a process that died or that is long past any resume', async () => {
    const clock = new FakeClock();
    // Lock times are wall-clock: the holder is another process.
    for (const holder of [{ pid: 2 ** 22 + 7, at: Date.now() }, { pid: process.pid, at: Date.now() - 10 * 60_000 }]) {
      const file = historyFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.lock`, JSON.stringify(holder));
      assert.deepEqual(await new RunawayGuard(clock, LIMITS, file).resumeWithinCaps('bx_a', resumeSteps().steps()), { ok: true });
    }
  });

  it('refuses past the live-sandbox limit without resuming', async () => {
    const provider = resumeSteps([sandbox('bx_a', 'stopped'), sandbox('bx_b', 'running')]);
    const guard = new RunawayGuard(new FakeClock(), { ...LIMITS, maxLiveSandboxes: 1 }, historyFile());
    const verdict = await guard.resumeWithinCaps('bx_a', provider.steps());
    assert.equal(verdict.ok ? '' : verdict.code, 'runaway-guard');
    assert.deepEqual(provider.calls, []);
  });
});
