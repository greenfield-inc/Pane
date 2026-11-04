import { describe, expect, it } from 'vitest';
import { hardenWebviewPreferences } from './webviewPreferences';

describe('hardenWebviewPreferences', () => {
  it('attaches every guest opaque and sandboxed, overriding what the renderer asked for', () => {
    const webPreferences = { preload: '/tmp/preload.js', nodeIntegration: true, contextIsolation: false, sandbox: false, transparent: true };
    hardenWebviewPreferences(webPreferences);
    expect(webPreferences).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true, transparent: false });
  });
});
