import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue } from '../../../../../shared/validation/boundaryDecoder';
import type { ComputerUseEngine, EngineResult } from '../engine';
import { ScriptHosts } from '../scriptHosts';
import { buildScriptHostChild } from '../../../test/computerUseFakes';

const child = buildScriptHostChild();
afterAll(child.cleanup);

let hosts: ScriptHosts | undefined;
afterEach(async () => {
  await hosts?.stopAll('test over');
  hosts = undefined;
});

const SHOT = { mime: 'image/png', base64: 'cG5n' };

/** Cua Driver answering for one Finder window whose list gains a row after any click. */
function finderEngine(options: { refuseBackgroundScroll?: boolean } = {}) {
  const calls: string[] = [];
  let clicked = false;
  const state = (): JsonObject => ({
    window_title: 'Downloads',
    tree_markdown: ['- AXWindow "Downloads"', '  - [0] AXButton "New Folder" [actions=[press]]', ...(clicked ? ['  - AXStaticText "untitled folder"'] : [])].join('\n'),
    elements: [{ role: 'AXButton', depth: 1, element_index: 0, element_token: `s0000000${clicked ? 2 : 1}:0`, label: 'New Folder', actions: ['AXPress'] }],
  });
  const engine: ComputerUseEngine = {
    id: 'cua-driver',
    status: async () => ({ installed: true, permissions: {}, desktopSession: true }),
    async call(tool, args): Promise<EngineResult> {
      calls.push(`${tool}${args.delivery_mode === 'foreground' ? ' (foreground)' : ''}`);
      switch (tool) {
        case 'list_apps':
          return { ok: true, data: { apps: [{ pid: 55, name: 'Finder', bundle_id: 'com.apple.finder', running: true }] } };
        case 'list_windows':
          return { ok: true, data: { windows: [{ window_id: 9, pid: 55, app_name: 'Finder', title: 'Downloads', z_index: 2, is_on_screen: true }] } };
        case 'get_window_state':
          return { ok: true, data: state(), images: [SHOT] };
        case 'click':
          clicked = true;
          return { ok: true, data: { effect: 'confirmed', route: 'accessibility', summary: 'pressed' } };
        case 'scroll':
          if (options.refuseBackgroundScroll && args.delivery_mode !== 'foreground') {
            return { ok: false, data: { code: 'background_unavailable', escalation: { recommended: 'foreground' } }, error: { code: 'tool_error', message: 'background_unavailable' } };
          }
          return { ok: true, data: { effect: 'unverifiable', route: 'synthetic_events', summary: 'scrolled' } };
        default:
          return { ok: false, error: { code: 'unexpected', message: `unexpected ${tool}` } };
      }
    },
    async stop() {},
  };
  return { engine, calls };
}

describe('cua in the script host', () => {
  it('runs a script against the app, reports a step per action, and keeps element ids across runs', async () => {
    const { engine } = finderEngine();
    hosts = new ScriptHosts({ getEngine: () => engine, childEntry: child.entry });
    const first = await hosts.run('a', `globalThis.app = await cua.getApp('Finder')`);
    expect(first).toEqual({ ok: true, text: ['Finder · "Downloads" · window 9', '1 window "Downloads"', '  2 button "New Folder"'].join('\n'), images: [] });

    const steps: JsonValue[] = [];
    const second = await hosts.run('a', `await app.click(2); await app.getAXState()`, (step) => steps.push(step));
    expect(second.text).toBe(['Finder · "Downloads" · window 9', 'Changes since the last read: 1 added, 0 removed, 0 changed.', '+ 3 staticText "untitled folder"'].join('\n'));
    expect(steps).toEqual([
      { index: 0, action: 'click', args: { app: 'Finder', windowId: 9, target: 2, button: 'left', clickCount: 1 }, result: 'ok', screenshot: { mime: 'image/png', base64: 'cG5n' }, at: expect.any(String) },
    ]);
  });

  it('returns needs_foreground, and the daemon shows the notice before a foreground retry acts', async () => {
    const { engine, calls } = finderEngine({ refuseBackgroundScroll: true });
    const notices: string[] = [];
    hosts = new ScriptHosts({
      getEngine: () => engine,
      childEntry: child.entry,
      showForegroundNotice: async ({ connectionId, app }) => {
        notices.push(`${connectionId}:${app}`);
        calls.push('notice');
        return `Pane: Claude Code is bringing ${app} to the front`;
      },
    });
    await hosts.run('a', `globalThis.app = await cua.getApp('Finder')`);

    const refused = await hosts.run('a', `await app.scroll(2, 'down')`);
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("needs_foreground: Finder can't receive scrolling in the background on this OS. Retry with { foreground: true } to bring it to the front; the user will see a notice first.");

    calls.length = 0;
    const retried = await hosts.run('a', `await app.scroll(2, 'down', 1, { foreground: true })`);
    expect(retried).toEqual({ ok: true, text: 'Pane: Claude Code is bringing Finder to the front', images: [] });
    expect(notices).toEqual(['a:Finder']);
    expect(calls.indexOf('notice')).toBeGreaterThan(-1);
    expect(calls.indexOf('notice')).toBeLessThan(calls.indexOf('scroll (foreground)'));
  });
});
