import { describe, expect, it } from 'vitest';

import type { PanePermissionRequest } from '@shared/types/permissions';

import { describePermission, pendingByPane } from './permissions';

const request = (id: string, sessionId: string, toolName: string, input: PanePermissionRequest['input'], timestamp = 1): PanePermissionRequest =>
  ({ id, sessionId, toolName, input, timestamp });

describe('describePermission', () => {
  it('leads with what the tool will act on', () => {
    expect(describePermission(request('r', 's', 'Bash', { command: 'rm -rf dist', description: 'Clean build' })))
      .toEqual({ title: 'Run a command', target: 'rm -rf dist', detail: '{\n  "command": "rm -rf dist",\n  "description": "Clean build"\n}' });
    expect(describePermission(request('r', 's', 'Edit', { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' })).target)
      .toBe('/repo/src/app.ts');
    expect(describePermission(request('r', 's', 'WebFetch', { url: 'https://example.com' })))
      .toMatchObject({ title: 'Use WebFetch', target: 'https://example.com' });
  });
});

describe('pendingByPane', () => {
  it('keeps each pane’s oldest waiting request', () => {
    const pending = pendingByPane([
      request('r2', 'a', 'Bash', {}, 20),
      request('r1', 'a', 'Edit', {}, 10),
      request('r3', 'b', 'Bash', {}, 30),
    ]);
    expect(Object.fromEntries(Object.entries(pending).map(([pane, item]) => [pane, item.id]))).toEqual({ a: 'r1', b: 'r3' });
  });
});
