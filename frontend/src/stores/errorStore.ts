import { create } from 'zustand';
import { ipcErrorMessage, stripIpcWrapper } from '../utils/ipcErrorMessage';

interface ErrorInfo {
  title?: string;
  error: string;
  details?: string;
  command?: string;
}

interface ErrorStore {
  currentError: ErrorInfo | null;
  showError: (error: ErrorInfo) => void;
  clearError: () => void;
}

export const useErrorStore = create<ErrorStore>((set) => ({
  currentError: null,
  
  showError: (error) => {
    console.error('[ErrorStore] Showing error:', error);
    set({
      currentError: {
        ...error,
        error: stripIpcWrapper(error.error),
        details: error.details === undefined ? undefined : stripIpcWrapper(error.details),
      },
    });
  },
  
  clearError: () => {
    set({ currentError: null });
  },
}));

/** A user action failed: `title` says what, the reason comes from the thrown error or the failed response's `error`. */
export function showActionError(title: string, cause: unknown): void {
  useErrorStore.getState().showError({ title, error: ipcErrorMessage(cause, 'Pane did not say why.') });
}
