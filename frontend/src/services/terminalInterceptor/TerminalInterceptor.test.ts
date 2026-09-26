import { describe, expect, it, vi } from 'vitest';
import { TerminalInterceptor } from './TerminalInterceptor';
import { createAtTerminalHandler } from './handlers/atTerminalHandler';

function setup() {
  const onFlush = vi.fn();
  const onCopy = vi.fn(async () => {});
  const interceptor = new TerminalInterceptor({ onStateChange: vi.fn(), onFlush });
  interceptor.registerHandler('@', createAtTerminalHandler({
    sessionId: 'session',
    currentPanelId: 'current',
    hasOtherTerminals: () => true,
    getTerminals: async () => [
      { panelId: 'one', title: 'First', preview: [] },
      { panelId: 'two', title: 'Second', preview: [] },
    ],
    onCopy,
    onStateChange: vi.fn(),
    onForceCancel: () => interceptor.forceCancel(),
    getPreference: async () => null,
    setPreference: vi.fn(),
  }));
  return { interceptor, onFlush, onCopy };
}

describe('TerminalInterceptor keyboard protocols', () => {
  it.each(['\x1b[1;3A', '\x1b[1;2D', '\x1b[1;2A', '\x1b[17~',
    '\x1b[38;72;0;1;258;1_', '\x1b[37;75;0;1;272;1_',
    '\x1b[38;72;0;1;272;1_', '\x1b[117;64;0;1;0;1_',
  ])('passes unconsumed input through: %j', (data) => {
    const { interceptor, onFlush } = setup();
    expect(interceptor.handleInput(data)).toEqual({ consumed: false });
    expect(onFlush).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'VT', trigger: '@', down: '\x1b[B', enter: '\r' },
    { name: 'Win32', trigger: '\x1b[50;3;64;1;16;1_', down: '\x1b[40;80;0;1;256;1_', enter: '\x1b[13;28;13;1;0;1_' },
  ])('preserves @ navigation and execution with $name input', async ({ trigger, down, enter }) => {
    const { interceptor, onCopy, onFlush } = setup();
    expect(interceptor.handleInput(trigger)).toEqual({ consumed: true });
    await vi.waitFor(() => expect(interceptor.getState().handlerState).toMatchObject({
      terminals: [{ panelId: 'one' }, { panelId: 'two' }],
    }));
    expect(interceptor.handleInput(down)).toEqual({ consumed: true });
    expect(interceptor.handleInput(enter)).toEqual({ consumed: true });
    expect(onCopy).toHaveBeenCalledWith('two', 500, 'raw');
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('ignores Win32 releases, modifier and lock keys while filtering, and flushes only text on Escape', () => {
    const { interceptor, onFlush } = setup();
    interceptor.handleInput('\x1b[50;3;64;1;16;1_');
    expect(interceptor.handleInput('\x1b[50;3;64;0;16;1_').consumed).toBe(true);
    expect(interceptor.handleInput('\x1b[16;42;0;0;0;1_').consumed).toBe(false);
    expect(interceptor.handleInput('\x1b[16;42;0;1;16;1_').consumed).toBe(false);
    expect(interceptor.handleInput('\x1b[20;58;0;1;128;1_').consumed).toBe(false);
    expect(interceptor.handleInput('\x1b[20;58;0;0;128;1_').consumed).toBe(false);
    interceptor.handleInput('\x1b[70;33;102;1;0;1_');
    expect(interceptor.getState().buffer).toBe('f');
    expect(interceptor.handleInput('\x1b[27;1;27;1;0;1_').consumed).toBe(true);
    expect(onFlush).toHaveBeenCalledWith('@f');
    expect(interceptor.getState().active).toBe(false);
    expect(interceptor.handleInput('\x1b[27;1;27;0;0;1_').consumed).toBe(true);
  });

  it('consumes Escape used to cancel the picker without sending a shell Meta prefix', () => {
    const { interceptor, onFlush } = setup();
    interceptor.handleInput('@');
    interceptor.handleInput('f');
    expect(interceptor.handleInput('\x1b')).toEqual({ consumed: true });
    expect(onFlush.mock.calls).toEqual([['@f']]);
    expect(interceptor.handleInput('x')).toEqual({ consumed: false });
  });

  it.each([
    'pasted text', '日本語', 'é', '\x03', '\x04', ' ',
    '\x1b[67;46;3;1;8;1_',
  ])('flushes the picker prefix once and forwards cancelling input unchanged: %j', (data) => {
    const { interceptor, onFlush } = setup();
    interceptor.handleInput('@');
    interceptor.handleInput('f');
    expect(interceptor.handleInput(data)).toEqual({ consumed: false });
    expect(onFlush.mock.calls).toEqual([['@f']]);
    expect(interceptor.getState().active).toBe(false);
  });

  it('preserves Backspace dismissal of an empty @ filter', () => {
    const { interceptor, onFlush } = setup();
    interceptor.handleInput('\x1b[50;3;64;1;16;1_');
    expect(interceptor.handleInput('\x1b[8;14;8;1;0;1_').consumed).toBe(true);
    expect(interceptor.getState().active).toBe(false);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('does not activate @ for Alt+@ or a key release', () => {
    const { interceptor } = setup();
    expect(interceptor.handleInput('\x1b[50;3;64;1;18;1_').consumed).toBe(false);
    expect(interceptor.handleInput('\x1b[50;3;64;0;16;1_').consumed).toBe(false);
    expect(interceptor.getState().active).toBe(false);
  });
});
