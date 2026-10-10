import { expect, it, vi } from 'vitest';
import { useErrorStore } from './errorStore';

it('shows the backend reason without Electron\'s IPC wrapper', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useErrorStore.getState().showError({
    title: 'Could not archive the Pane',
    error: "Error invoking remote method 'sessions:delete': Error: The Pane is still starting. Wait for it to finish, then try again.",
    details: "Error invoking remote method 'sessions:delete': Error: worktree is locked",
  });
  expect(useErrorStore.getState().currentError).toEqual({
    title: 'Could not archive the Pane',
    error: 'The Pane is still starting. Wait for it to finish, then try again.',
    details: 'worktree is locked',
  });
});
