import { expect, it } from 'vitest';
import { nativeChatHookSettings } from './hookSettings';

it('uses a declared Windows hook shell with a process-local Electron setting and literal paths', () => {
  const settings = nativeChatHookSettings("C:\\Users\\O'Brien\\chat\\lifecycle.jsonl", 'win32');
  const hook = settings.hooks.SessionStart[0].hooks[0];
  expect(hook.shell).toBe('powershell');
  expect(hook.command).toMatch(/^\$env:ELECTRON_RUN_AS_NODE='1'; & /);
  expect(hook.command).toContain("'C:\\Users\\O''Brien\\chat\\lifecycle.jsonl'");
  expect(settings.hooks.SessionEnd[0].hooks[0]).toEqual(hook);
});
