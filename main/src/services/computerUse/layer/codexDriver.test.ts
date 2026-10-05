import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../../../../shared/validation/boundaryDecoder';
import type { EngineResult } from '../engine';
import { createCua } from './cua';
import { codexDriver } from './codexDriver';
import type { StepRecord } from './driver';

const SHOT = { mime: 'image/jpeg', base64: '/9j/4A==' };
const FULL = 'Window: "Untitled", App: TextEdit.\n0 standard window Untitled\n\t2 text entry area (settable) First Text View';
/** Each diff read numbers itself, so a test can tell which read a line came from. */
const diff = (n: number) => `~\t\t2 text entry area (settable) Value: read ${n}`;

/**
 * The Codex engine on macOS, as the layer sees it: app-keyed verbs, its own rendered text, a diff
 * on every read (its baseline outlives connections, and a screenshot read moves it too), and a full
 * tree on `disable_diff`.
 */
function codexMac() {
  const calls: Array<{ tool: string; args: JsonObject }> = [];
  let diffs = 0;
  async function call(tool: string, args: JsonObject): Promise<EngineResult> {
    calls.push({ tool, args });
    switch (tool) {
      case 'list_apps':
        return { ok: true, data: { apps: [{ id: 'com.apple.TextEdit', displayName: 'TextEdit', isRunning: true }, { id: 'com.apple.Notes', displayName: 'Notes', isRunning: false }] } };
      case 'get_app_state':
        return { ok: true, data: { state: args.disable_diff === true ? FULL : diff(++diffs) } };
      case 'state_and_screenshot':
        return { ok: true, data: { state: diff(++diffs) }, images: [SHOT] };
      default:
        return { ok: true, data: {} };
    }
  }
  const output: string[] = [];
  const steps: StepRecord[] = [];
  const { cua } = createCua({
    driver: codexDriver(call, 'mac'),
    write: (text) => output.push(text),
    emitImage: () => output.push('[image]'),
    recordStep: (step) => steps.push(step),
    // Large on purpose: a native engine settles itself, so the layer must not wait.
    settleMs: 60_000,
  });
  return { cua, calls, output, steps };
}

describe('the layer over the Codex runtime', () => {
  it("passes the runtime's own tree and diffs through, including the diff its step screenshot read, and acts by its element ids", async () => {
    const { cua, calls, output } = codexMac();

    const app = await cua.getApp('TextEdit');
    await app.typeText('hi');
    const state = await app.getAXState({ emit: false });
    const full = await app.getAXState({ emit: false, disableDiffing: true });
    await app.click(2);

    expect(output[0]).toContain(FULL);
    // The step screenshot after typing read diff 1; the agent's own read is diff 2.
    expect(state).toContain(`${diff(1)}\n${diff(2)}`);
    expect(full).toContain(FULL);
    expect(calls.filter((c) => c.tool !== 'list_apps' && c.tool !== 'state_and_screenshot')).toEqual([
      { tool: 'get_app_state', args: { app: 'com.apple.TextEdit', pid: 1, disable_diff: true } },
      { tool: 'type_text', args: { app: 'com.apple.TextEdit', pid: 1, text: 'hi' } },
      { tool: 'get_app_state', args: { app: 'com.apple.TextEdit', pid: 1, disable_diff: false } },
      { tool: 'get_app_state', args: { app: 'com.apple.TextEdit', pid: 1, disable_diff: true } },
      { tool: 'click', args: { app: 'com.apple.TextEdit', pid: 1, element_index: 2, mouse_button: 'left', click_count: 1 } },
    ]);
  });

  it('records each step with a screenshot, without a tree read or a settle wait', async () => {
    const { cua, calls, steps } = codexMac();
    const app = await cua.getApp('TextEdit');
    const readsBefore = calls.filter((c) => c.tool === 'get_app_state').length;

    await app.pressKey('super+n');

    expect(calls.filter((c) => c.tool === 'get_app_state')).toHaveLength(readsBefore);
    expect(steps).toEqual([expect.objectContaining({ index: 0, action: 'pressKey', result: 'ok' })]);
    expect(calls.at(-1)).toEqual({ tool: 'state_and_screenshot', args: { app: 'com.apple.TextEdit', pid: 1 } });
  });

  it("uses the runtime's own select_text and paste, leaving the clipboard to it", async () => {
    const { cua, calls } = codexMac();
    const app = await cua.getApp('TextEdit');

    await app.selectText(2, 'hi', { suffix: '!' });
    await app.paste('**bold**', { format: 'md' });

    expect(calls.filter((c) => c.tool === 'select_text' || c.tool === 'paste')).toEqual([
      { tool: 'select_text', args: { app: 'com.apple.TextEdit', pid: 1, element_index: 2, text: 'hi', prefix: '', suffix: '!', selection_type: 'text' } },
      { tool: 'paste', args: { app: 'com.apple.TextEdit', pid: 1, text: '**bold**', format: 'md' } },
    ]);
  });

  it("reports the runtime's refusal as the action's error", async () => {
    const calls: string[] = [];
    const { cua } = createCua({
      driver: codexDriver(async (tool) => {
        calls.push(tool);
        if (tool === 'list_apps') return { ok: true, data: { apps: [{ id: 'com.apple.Terminal', displayName: 'Terminal', isRunning: true }] } };
        if (tool === 'type_text') return { ok: false, error: { code: 'codex_error', message: "Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons." } };
        return { ok: true, data: { state: 'Window: "zsh", App: Terminal.' } };
      }, 'mac'),
      write: () => undefined,
      emitImage: () => undefined,
      });
    const app = await cua.getApp('Terminal');

    await expect(app.typeText('ls')).rejects.toThrow('not allowed to use the app');
  });

  it('marks each input on Windows as foreground, so the daemon shows the notice, and puts its line in the result', async () => {
    const inputs: JsonObject[] = [];
    const output: string[] = [];
    const { cua } = createCua({
      driver: codexDriver(async (tool, args) => {
        if (tool === 'list_windows') return { ok: true, data: { windows: [{ id: 5, app: 'Notepad', title: 'notes.txt' }] } };
        if (tool === 'get_app_state' || tool === 'state_and_screenshot') return { ok: true, data: { state: 'There has been no change in the accessibility tree.' } };
        inputs.push({ tool, ...args });
        // The daemon shows the notice for foreground calls and returns its line.
        return { ok: true, data: { broughtForward: true }, notice: args.delivery_mode === 'foreground' ? 'Notice shown: Notepad came to the front.' : undefined };
      }, 'windows'),
      write: (text) => output.push(text),
      emitImage: () => undefined,
    });
    const app = await cua.getApp({ windowId: 5 });

    await app.typeText('hi');

    expect(inputs).toEqual([{ tool: 'type_text', window_id: 5, pid: 5, delivery_mode: 'foreground', text: 'hi' }]);
    expect(output).toContain('Notice shown: Notepad came to the front.');
  });
});
