import { describe, expect, it, vi } from 'vitest';
import { ideMenuItems } from './ideMenuItems';

describe('ideMenuItems', () => {
  it('lists VS Code and Cursor when nothing custom is configured', () => {
    const items = ideMenuItems(undefined, vi.fn());
    expect(items.map((item) => item.label)).toEqual(['VS Code', 'Cursor']);
  });

  it('leads with a custom command and names where it is configured', () => {
    expect(ideMenuItems({ command: 'subl .', source: 'project' }, vi.fn())[0]).toMatchObject({
      id: 'configured', label: 'subl .', description: 'Project default',
    });
    expect(ideMenuItems({ command: 'zed .', source: 'app' }, vi.fn())[0]).toMatchObject({
      id: 'configured', label: 'zed .', description: 'Default for all projects',
    });
  });

  it('does not repeat a configured built-in IDE', () => {
    const items = ideMenuItems({ command: 'cursor .', source: 'app' }, vi.fn());
    expect(items.map((item) => item.id)).toEqual(['vscode', 'cursor']);
  });

  it('opens the configured IDE without a key and a built-in IDE by its key', () => {
    const openIde = vi.fn();
    const [configured, , cursor] = ideMenuItems({ command: 'subl .', source: 'project' }, openIde);
    configured.onClick?.();
    cursor.onClick?.();
    expect(openIde.mock.calls).toEqual([[], ['cursor']]);
  });
});
