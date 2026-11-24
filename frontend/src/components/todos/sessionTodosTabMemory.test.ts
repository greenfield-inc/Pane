import { beforeEach, describe, expect, it } from 'vitest';
import { showSessionTodo, useTabMemory } from './sessionTodosTabMemory';
import { useConfigStore } from '../../stores/configStore';

/** T-51 review F-4: two machines can each have a Session "billing", and each has its own T-5. */

beforeEach(() => {
  useTabMemory.setState({ tabs: {} });
  useConfigStore.setState({ config: null });
});

describe('a Session\'s To-dos tab memory', () => {
  it('keeps this computer\'s Session and the mini\'s Session with the same id apart, each with its own open T-5', () => {
    showSessionTodo('billing', 5, 'local');
    const tabs = useTabMemory.getState().tabs;
    // Only this computer's Session remembers an open T-5, and it says whose T-5.
    expect(Object.keys(tabs)).toEqual(['local:billing']);
    expect(tabs['local:billing']?.view).toEqual({ kind: 'todo', machineId: 'local', number: 5 });
    expect(tabs['mini:billing']).toBeUndefined();
    showSessionTodo('billing', 5, 'mini');
    expect(useTabMemory.getState().tabs['mini:billing']?.view).toEqual({ kind: 'todo', machineId: 'mini', number: 5 });
    expect(useTabMemory.getState().tabs['local:billing']?.view).toEqual({ kind: 'todo', machineId: 'local', number: 5 });
  });

  it('opens on the computer the window shows when no machine is named', () => {
    showSessionTodo('billing', 7);
    expect(useTabMemory.getState().tabs['local:billing']?.view).toEqual({ kind: 'todo', machineId: 'local', number: 7 });
  });
});
