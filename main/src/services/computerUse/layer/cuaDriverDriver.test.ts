import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../../../../shared/validation/boundaryDecoder';
import type { EngineResult } from '../engine';
import { cuaDriverDriver, parseKey } from './cuaDriverDriver';
import { WindowGoneError } from './driver';

const WINDOW = { id: 31, pid: 900, app: 'TextEdit' };
const SHOT = { mime: 'image/png', base64: 'cG5n' };

/**
 * A TextEdit window as cua-driver-rs 0.33.3 reports it (get_window_state.rs, ax/tree.rs): the
 * markdown lists every row, `elements` only the indexed ones, with tokens and raw AX fields.
 */
const TEXTEDIT_STATE: JsonObject = {
  window_id: 31,
  pid: 900,
  snapshot_id: 's0000002a',
  app_name: 'TextEdit',
  window_title: 'Untitled',
  element_count: 3,
  tree_markdown: [
    '- AXWindow "Untitled"',
    '  - [0] AXButton (close button) [actions=[press]]',
    '  - AXScrollArea',
    '    - [1] AXTextArea = "Dear Ada," [actions=[showmenu]]',
    '  - AXStaticText "Saved"',
    '  - [2] AXPopUpButton "Styles" = "Body" [actions=[press,showmenu]]',
    '',
  ].join('\n'),
  elements: [
    { role: 'AXButton', depth: 1, element_index: 0, element_token: 's0000002a:0', label: 'close button', actions: ['AXPress'] },
    { role: 'AXTextArea', depth: 2, element_index: 1, element_token: 's0000002a:1', value: 'Dear Ada,', actions: ['AXShowMenu'], parent_index: 0 },
    { role: 'AXPopUpButton', depth: 1, element_index: 2, element_token: 's0000002a:2', label: 'Styles', value: 'Body', actions: ['AXPress', 'AXShowMenu'] },
  ],
};

function engine(responses: Record<string, EngineResult>) {
  const calls: Array<[string, JsonObject]> = [];
  const call = async (tool: string, args: JsonObject): Promise<EngineResult> => {
    calls.push([tool, args]);
    return responses[tool] ?? { ok: true, data: { effect: 'confirmed', route: 'accessibility', summary: 'ok' } };
  };
  return { call, calls };
}

describe('cuaDriverDriver', () => {
  it('reads a window into one tree: structure and text from the markdown, tokens from elements', async () => {
    const { call } = engine({ get_window_state: { ok: true, data: TEXTEDIT_STATE, images: [SHOT] } });
    const snapshot = await cuaDriverDriver(call, 'mac').readWindow(WINDOW);
    expect(snapshot.title).toBe('Untitled');
    expect(snapshot.busy).toBe(false);
    expect(snapshot.screenshot).toEqual(SHOT);
    expect(snapshot.elements.map(({ ref, role, label, value, actions, parent }) => ({ ref, role, label, value, actions, parent }))).toEqual([
      { ref: undefined, role: 'window', label: 'Untitled', value: undefined, actions: [], parent: null },
      { ref: 's0000002a:0', role: 'button', label: 'close button', value: undefined, actions: [], parent: 0 },
      { ref: undefined, role: 'scrollArea', label: undefined, value: undefined, actions: [], parent: 0 },
      { ref: 's0000002a:1', role: 'textArea', label: undefined, value: 'Dear Ada,', actions: ['Show Menu'], parent: 2 },
      { ref: undefined, role: 'staticText', label: 'Saved', value: undefined, actions: [], parent: 0 },
      { ref: 's0000002a:2', role: 'popUpButton', label: 'Styles', value: 'Body', actions: ['Show Menu'], parent: 0 },
    ]);
  });

  it('keeps a multi-line value inside its row, and reads titles and descriptions of display rows', async () => {
    const markdown = [
      '- AXWindow "Notes"',
      '  - [0] AXTextArea = "foo',
      '- bar',
      'baz" [actions=[showmenu]]',
      '  - AXStaticText "Saved" (status)',
      '  - AXImage (logo)',
      '  - [1] AXButton "Save" [actions=[press]]',
    ].join('\n');
    const { call } = engine({
      get_window_state: {
        ok: true,
        data: {
          tree_markdown: markdown,
          elements: [
            { role: 'AXTextArea', depth: 1, element_index: 0, element_token: 's1:0', value: 'foo\n- bar\nbaz', actions: ['AXShowMenu'] },
            { role: 'AXButton', depth: 1, element_index: 1, element_token: 's1:1', label: 'Save', actions: ['AXPress'] },
          ],
        },
      },
    });
    const { elements } = await cuaDriverDriver(call, 'mac').readWindow(WINDOW);
    expect(elements.map(({ role, label, value, parent }) => [role, label, value, parent])).toEqual([
      ['window', 'Notes', undefined, null],
      ['textArea', undefined, 'foo\n- bar\nbaz', 0],
      ['staticText', 'Saved', undefined, 0],
      ['image', 'logo', undefined, 0],
      ['button', 'Save', undefined, 0],
    ]);
  });

  it('reports busy while a spinner or an indeterminate progress indicator shows', async () => {
    const read = async (markdown: string) => {
      const { call } = engine({ get_window_state: { ok: true, data: { tree_markdown: markdown, elements: [] } } });
      return (await cuaDriverDriver(call, 'mac').readWindow(WINDOW)).busy;
    };
    expect(await read('- AXWindow\n  - AXProgressIndicator')).toBe(true);
    expect(await read('- AXWindow\n  - AXBusyIndicator')).toBe(true);
    expect(await read('- AXWindow\n  - AXProgressIndicator = "40"')).toBe(false);
  });

  it('refuses with the missing grants when Cua returns an empty, degraded tree for lack of permission', async () => {
    const degraded = { ok: true, data: { degraded: true, degraded_reason: 'ax_window_unresolved: …', elements: [], screenshot_error: { code: 'px_capture_unavailable' } } };
    const grants = (accessibility: boolean, screenRecording: boolean): EngineResult => ({
      ok: true,
      data: { accessibility, screen_recording: screenRecording, source: { attribution: 'driver-daemon' } },
    });
    const noGrants = engine({ get_window_state: degraded, check_permissions: grants(false, false) });
    await expect(cuaDriverDriver(noGrants.call, 'mac').readWindow(WINDOW)).rejects.toThrow(
      'Computer use needs permission on this machine: Accessibility and Screen Recording. Ask the user to grant it (Settings → Remote Access).',
    );
    // With both grants, an empty degraded read is just a window Cua can't resolve yet.
    const granted = engine({ get_window_state: degraded, check_permissions: grants(true, true) });
    expect((await cuaDriverDriver(granted.call, 'mac').readWindow(WINDOW)).elements).toEqual([]);
  });

  it('turns a missing window into WindowGoneError', async () => {
    const { call } = engine({
      get_window_state: { ok: false, data: { code: 'window_id_not_found' }, error: { code: 'window_id_not_found', message: 'window_id 31 not found' } },
    });
    await expect(cuaDriverDriver(call, 'mac').readWindow(WINDOW)).rejects.toBeInstanceOf(WindowGoneError);
  });

  it('flags each refusal shape that a foreground retry fixes', async () => {
    const refuse = (data: JsonObject): EngineResult => ({ ok: false, data, error: { code: 'tool_error', message: 'refused' } });
    const cases: Array<[JsonObject, boolean]> = [
      [{ code: 'background_unavailable', escalation: { recommended: 'foreground' } }, true],
      [{ code: 'off_space_or_ax_unresolved', effect: 'refused' }, true],
      [{ status: 'refused', refusal: { code: 'stale_element_token', message: 'stale' } }, false],
      [{ code: 'screenshot_context_missing' }, false],
      [{ code: 'window_not_found' }, false],
    ];
    for (const [data, needsForeground] of cases) {
      const { call } = engine({ scroll: refuse(data) });
      const outcome = await cuaDriverDriver(call, 'mac').perform(WINDOW, { kind: 'scroll', target: { ref: 's1:1' }, direction: 'down', amount: 1, by: 'page' }, { foreground: false });
      expect(outcome).toMatchObject({ ok: false, needsForeground, message: 'refused' });
    }
  });

  it('sends foreground actions with the window, and background ones without raising it', async () => {
    const { call, calls } = engine({});
    const driver = cuaDriverDriver(call, 'mac');
    await driver.perform(WINDOW, { kind: 'click', target: { ref: 's1:4' }, button: 'left', count: 1 }, { foreground: false });
    await driver.perform(WINDOW, { kind: 'click', target: { x: 10, y: 20 }, button: 'right', count: 1 }, { foreground: true });
    await driver.perform(WINDOW, { kind: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }, { foreground: true });
    expect(calls).toEqual([
      ['click', { pid: 900, element_token: 's1:4', button: 'left' }],
      ['click', { pid: 900, delivery_mode: 'foreground', window_id: 31, x: 10, y: 20, button: 'right' }],
      ['drag', { pid: 900, delivery_mode: 'foreground', window_id: 31, from_x: 1, from_y: 2, to_x: 3, to_y: 4 }],
    ]);
  });

  it('runs a secondary action Cua supports, and names the ones it does when asked for another', async () => {
    const { call, calls } = engine({});
    const driver = cuaDriverDriver(call, 'mac');
    expect(await driver.perform(WINDOW, { kind: 'secondaryAction', ref: 's1:2', action: 'Show Menu' }, { foreground: false })).toEqual({ ok: true });
    expect(calls[0]).toEqual(['click', { pid: 900, element_token: 's1:2', action: 'show_menu' }]);
    expect(await driver.perform(WINDOW, { kind: 'secondaryAction', ref: 's1:2', action: 'Increment' }, { foreground: false })).toEqual({
      ok: false,
      needsForeground: false,
      message: 'Cua Driver can\'t run "Increment". It runs Show Menu, Pick, Confirm, Cancel, Open on this OS.',
    });
  });

  it('selects text by focusing the field and walking there with arrow keys', async () => {
    const { call, calls } = engine({});
    await cuaDriverDriver(call, 'mac').perform(WINDOW, { kind: 'selectText', ref: 's1:1', start: 2, length: 1 }, { foreground: false });
    expect(calls.map(([tool, args]) => (tool === 'click' ? `click ${JSON.stringify(args.element_token)}` : `${tool} ${JSON.stringify(args.key)} ${JSON.stringify(args.modifiers)}`))).toEqual([
      'click "s1:1"',
      'press_key "up" ["cmd"]',
      'press_key "right" undefined',
      'press_key "right" undefined',
      'press_key "right" ["shift"]',
    ]);
  });

  it('only restores clipboards that hold plain text', async () => {
    const read = async (types: string[]) => {
      const { call } = engine({ clipboard_read: { ok: true, data: { supported: true, types, text: 'hi' } } });
      return cuaDriverDriver(call, 'mac').readClipboard();
    };
    expect(await read(['public.utf8-plain-text'])).toEqual({ text: 'hi', restorable: true });
    expect(await read(['public.png'])).toEqual({ text: 'hi', restorable: false });
    expect(await read(['public.rtf', 'public.utf8-plain-text'])).toEqual({ text: 'hi', restorable: false });
  });

  it('maps list_apps and list_windows to apps and windows', async () => {
    const { call } = engine({
      list_apps: { ok: true, data: { apps: [{ pid: 900, name: 'TextEdit', bundle_id: 'com.apple.TextEdit', running: true, launch_path: '/System/Applications/TextEdit.app' }, { pid: 0, name: 'Notes', bundle_id: 'com.apple.Notes', running: false, launch_path: null }] } },
      list_windows: { ok: true, data: { windows: [{ window_id: 31, pid: 900, app_name: 'TextEdit', title: 'Untitled', z_index: 4, is_on_screen: true }, { window_id: 32, pid: 900, app_name: 'TextEdit', title: '', z_index: null, is_on_screen: false }] } },
    });
    const driver = cuaDriverDriver(call, 'mac');
    expect(await driver.listApps()).toEqual([
      { id: 'com.apple.TextEdit', displayName: 'TextEdit', path: '/System/Applications/TextEdit.app', isRunning: true, pid: 900 },
      { id: 'com.apple.Notes', displayName: 'Notes', isRunning: false },
    ]);
    expect(await driver.listWindows()).toEqual([
      { id: 31, pid: 900, app: 'TextEdit', title: 'Untitled', zIndex: 4, onScreen: true },
      { id: 32, pid: 900, app: 'TextEdit', onScreen: false },
    ]);
  });
});

describe('parseKey', () => {
  it('turns xdotool chords into Cua keys and modifiers', () => {
    expect(parseKey('Return', 'mac')).toEqual({ key: 'return', modifiers: [] });
    expect(parseKey('ctrl+shift+t', 'linux')).toEqual({ key: 't', modifiers: ['ctrl', 'shift'] });
    expect(parseKey('super+c', 'mac')).toEqual({ key: 'c', modifiers: ['cmd'] });
    expect(parseKey('Control_L+a', 'windows')).toEqual({ key: 'a', modifiers: ['ctrl'] });
    expect(parseKey('alt+Page_Down', 'mac')).toEqual({ key: 'pagedown', modifiers: ['option'] });
    expect(parseKey('Delete', 'mac')).toEqual({ key: 'forward_delete', modifiers: [] });
    expect(parseKey('BackSpace', 'windows')).toEqual({ key: 'backspace', modifiers: [] });
    expect(parseKey('A', 'mac')).toEqual({ key: 'a', modifiers: ['shift'] });
    expect(parseKey('ctrl+T', 'linux')).toEqual({ key: 't', modifiers: ['ctrl'] });
    expect(parseKey('ctrl++', 'linux')).toEqual({ key: '+', modifiers: ['ctrl'] });
    expect(() => parseKey('hyper+x', 'mac')).toThrow('Unknown modifier "hyper"');
  });
});
