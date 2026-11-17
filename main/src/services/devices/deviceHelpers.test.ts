import { describe, expect, it } from 'vitest';
import { PaneError } from '../../../../shared/paneError';
import { refuseRetarget } from './deviceHelpers';

function refusal(args: string[]): string | undefined {
  try {
    refuseRetarget(args);
    return undefined;
  } catch (cause) {
    return cause instanceof PaneError ? cause.code : String(cause);
  }
}

describe('device_act retarget refusal', () => {
  it.each([
    [['snapshot', '-i']],
    [['press', '@e3', '--settle']],
    [['open', 'com.apple.Preferences', '--foreground']],
    [['fill', '@e2', 'hello', '--settle']],
    [['screenshot', '/tmp/shot.png', '--json']],
  ])('lets %j through', (args) => {
    expect(refusal(args)).toBeUndefined();
  });

  it.each([
    [['snapshot', '--udid', 'OTHER']],
    [['snapshot', '--udid=OTHER']],
    [['press', '@e1', '--serial', 'emulator-5556']],
    [['open', 'app', '--session', 'pane-other']],
    [['snapshot', '--device', 'iPhone 16']],
    [['snapshot', '--state-dir', '/tmp/x']],
    [['snapshot', '--ios-simulator-device-set', '/tmp/set']],
    [['snapshot', '--android-device-allowlist', 'emulator-5556']],
    [['snapshot', '--daemon-base-url', 'http://127.0.0.1:1']],
    [['snapshot', '--remote-config', 'x.json']],
  ])('refuses the retargeting flag in %j', (args) => {
    expect(refusal(args)).toBe('ERR_DEVICE_ACT_FLAG');
  });

  it.each([
    [['daemon', 'stop']],
    [['session', 'list']],
    [['disconnect']],
    [['proxy']],
    [['batch', '--steps', '[]']],
  ])('refuses %j, which acts on what every Pane shares', (args) => {
    expect(refusal(args)).toBe('ERR_DEVICE_ACT_COMMAND');
  });
});
