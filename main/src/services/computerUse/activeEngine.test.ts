import { describe, expect, it } from 'vitest';
import type { ComputerUseEngineChoice } from '../../../../shared/types/computerUse';
import { createEngineSelector } from './activeEngine';
import type { ComputerUseEngine, EngineResult, EngineStatus } from './engine';

function engine(id: ComputerUseEngine['id'], status: Partial<EngineStatus> = {}, listApps: EngineResult = { ok: true, data: [] }) {
  const calls: string[] = [];
  let stops = 0;
  const fake: ComputerUseEngine = {
    id,
    status: async () => ({ installed: true, permissions: {}, desktopSession: true, ...status }),
    async call(tool) {
      calls.push(tool);
      return tool === 'list_apps' ? listApps : { ok: true, data: { engine: id } };
    },
    async stop() { stops += 1; },
  };
  return { fake, calls, stops: () => stops };
}

function selector(codex: ComputerUseEngine, cua: ComputerUseEngine, choice: ComputerUseEngineChoice = 'auto') {
  return createEngineSelector({ engineChoice: () => choice, codex, cua });
}

describe('engine selection', () => {
  it('runs on the Codex runtime when Auto finds it answering', async () => {
    const codex = engine('codex');
    const selected = selector(codex.fake, engine('cua-driver').fake);

    await expect(selected.status()).resolves.toEqual({ installed: true, permissions: {}, desktopSession: true });
    expect(selected.id).toBe('codex');
    await expect(selected.call('get_app_state', { app: 'TextEdit' })).resolves.toEqual({ ok: true, data: { engine: 'codex' } });
  });

  it('falls back to Cua Driver and names the reason when ChatGPT is missing', async () => {
    const selected = selector(engine('codex', { installed: false, detail: 'ChatGPT is not installed.' }).fake, engine('cua-driver').fake);

    await expect(selected.status()).resolves.toMatchObject({ installed: true, fallbackReason: 'Codex runtime not used: ChatGPT is not installed.' });
    expect(selected.id).toBe('cua-driver');
    await expect(selected.call('click', {})).resolves.toEqual({ ok: true, data: { engine: 'cua-driver' } });
  });

  it('falls back to Cua Driver when the runtime refuses calls from Pane', async () => {
    const codex = engine('codex', {}, { ok: false, error: { code: 'codex_error', message: 'Sender process is not authenticated' } });
    const selected = selector(codex.fake, engine('cua-driver').fake);

    await expect(selected.status()).resolves.toMatchObject({
      fallbackReason: 'Codex runtime not used: it refused calls from Pane (Sender process is not authenticated).',
    });
    expect(selected.id).toBe('cua-driver');
    expect(codex.stops()).toBeGreaterThan(0);
  });

  it('uses Cua Driver without trying Codex when the machine is set to Cua Driver', async () => {
    const codex = engine('codex');
    const selected = selector(codex.fake, engine('cua-driver').fake, 'cua-driver');

    await expect(selected.status()).resolves.toEqual({ installed: true, permissions: {}, desktopSession: true });
    expect(selected.id).toBe('cua-driver');
    expect(codex.calls).toEqual([]);
  });

  it('picks again on the next status, so a newly installed ChatGPT is used', async () => {
    let installed = false;
    const codex = engine('codex');
    codex.fake.status = async () => ({ installed, permissions: {}, desktopSession: true });
    const selected = selector(codex.fake, engine('cua-driver').fake);

    await selected.status();
    expect(selected.id).toBe('cua-driver');
    installed = true;
    await selected.status();
    expect(selected.id).toBe('codex');
  });

  it('keeps a Codex runtime with calls in flight on a later check, without testing or stopping it', async () => {
    let finishCall: () => void = () => undefined;
    const codex = engine('codex');
    const call = codex.fake.call;
    codex.fake.call = (tool, args) => (tool === 'list_apps' ? call(tool, args) : new Promise((resolve) => { finishCall = () => resolve(call(tool, args)); }));
    const selected = selector(codex.fake, engine('cua-driver').fake);
    await selected.status();

    const running = selected.call('click', {});
    await Promise.resolve();
    await selected.status();
    finishCall();
    await running;

    expect(selected.id).toBe('codex');
    expect(codex.calls).toEqual(['list_apps', 'click']);
    expect(codex.stops()).toBe(0);
  });

  it('falls back to Cua Driver when a selected runtime stops answering a later check', async () => {
    let answering = true;
    const codex = engine('codex');
    codex.fake.call = async () => (answering ? { ok: true, data: [] } : { ok: false, error: { code: 'engine_error', message: 'The Codex runtime exited.' } });
    const selected = selector(codex.fake, engine('cua-driver').fake);
    await selected.status();

    answering = false;
    const status = await selected.status();

    expect(selected.id).toBe('cua-driver');
    expect(status.fallbackReason).toBe('Codex runtime not used: it refused calls from Pane (The Codex runtime exited.).');
  });

  it('falls back mid-session when the runtime itself fails a call and stays down, and says so', async () => {
    let answering = true;
    let fallbacks = 0;
    const codex = engine('codex');
    codex.fake.call = async () => (answering ? { ok: true, data: [] } : { ok: false, error: { code: 'engine_error', message: "The Codex runtime didn't answer within 75 s." } });
    const cua = engine('cua-driver');
    const selected = createEngineSelector({ engineChoice: () => 'auto', codex: codex.fake, cua: cua.fake, onFallback: () => { fallbacks += 1; } });
    await selected.status();

    answering = false;
    await selected.call('click', {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(selected.id).toBe('cua-driver');
    expect(fallbacks).toBe(1);
    await expect(selected.call('click', {})).resolves.toEqual({ ok: true, data: { engine: 'cua-driver' } });
  });

  it('keeps the runtime when only one action fails', async () => {
    const codex = engine('codex');
    const call = codex.fake.call;
    codex.fake.call = async (tool, args) => (tool === 'click' ? { ok: false, error: { code: 'codex_error', message: 'Element 99 does not exist' } } : call(tool, args));
    const selected = selector(codex.fake, engine('cua-driver').fake);
    await selected.status();

    await selected.call('click', {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(selected.id).toBe('codex');
  });

  it('leaves no engine running when computer use stops during a selection', async () => {
    let finishStatus: () => void = () => undefined;
    const codex = engine('codex');
    const status = codex.fake.status;
    codex.fake.status = () => {
      codex.fake.status = status;
      return new Promise((resolve) => { finishStatus = () => resolve(status()); });
    };

    const cua = engine('cua-driver');
    let cuaStatusReads = 0;
    const cuaStatus = cua.fake.status;
    cua.fake.status = () => { cuaStatusReads += 1; return cuaStatus(); };
    const selected = selector(codex.fake, cua.fake);

    const checking = selected.status();
    await selected.stop();
    const stopsAfterTurnOff = codex.stops();
    finishStatus();
    await checking;

    expect(codex.stops()).toBeGreaterThan(stopsAfterTurnOff);
    // Reading Cua Driver's status starts its helper, so a turned-off check must not.
    expect(cuaStatusReads).toBe(0);
  });
});
