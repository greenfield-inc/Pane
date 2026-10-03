import { create } from 'zustand';
import { API } from '../utils/api';

export interface SessionCreationPreferences {
  sessionCount: number;
  toolType: 'claude' | 'none';
  selectedTools: {
    claude: boolean;
  };
  claudeConfig: {
    model: 'auto' | 'sonnet' | 'opus' | 'haiku';
    permissionMode: 'ignore' | 'approve';
    ultrathink: boolean;
  };
  showAdvanced: boolean;
  showSessionOptions: boolean;
  startPinned: boolean;
  baseBranch?: string;
}

const defaultPreferences: SessionCreationPreferences = {
  sessionCount: 1,
  toolType: 'none',
  selectedTools: {
    claude: true
  },
  claudeConfig: {
    model: 'opus',
    permissionMode: 'ignore',
    ultrathink: false
  },
  showAdvanced: false,
  showSessionOptions: false,
  startPinned: false
};

interface SessionPreferencesStore {
  preferences: SessionCreationPreferences;
  isLoading: boolean;
  error: string | null;
  loadPreferences: () => Promise<void>;
  updatePreferences: (updates: Partial<SessionCreationPreferences>) => Promise<void>;
}

export const useSessionPreferencesStore = create<SessionPreferencesStore>((set, get) => {
  let savedPreferences = defaultPreferences;
  let revision = 0;
  let loadRequestId = 0;
  let saveQueue = Promise.resolve();

  return {
    preferences: defaultPreferences,
    isLoading: false,
    error: null,

    loadPreferences: async () => {
      const loadRevision = revision;
      const requestId = ++loadRequestId;
      set({ isLoading: true, error: null });
      try {
        // A dialog can reopen while its last edit is still being saved.
        await saveQueue;
        if (loadRevision !== revision || requestId !== loadRequestId) return;
        const response = await API.config.getSessionPreferences();
        if (loadRevision !== revision || requestId !== loadRequestId) return;
        if (response.success && response.data) {
          const mergedPreferences: SessionCreationPreferences = {
            ...defaultPreferences,
            ...response.data,
            selectedTools: {
              ...defaultPreferences.selectedTools,
              ...response.data.selectedTools
            },
            claudeConfig: {
              ...defaultPreferences.claudeConfig,
              ...response.data.claudeConfig
            },
            sessionCount: defaultPreferences.sessionCount
          };
          savedPreferences = mergedPreferences;
          set({ preferences: mergedPreferences });
        } else {
          set({ error: response.error || 'Failed to load session preferences' });
        }
      } catch {
        if (loadRevision === revision && requestId === loadRequestId) {
          set({ error: 'Failed to load session preferences' });
        }
      } finally {
        if (requestId === loadRequestId) set({ isLoading: false });
      }
    },

    updatePreferences: (updates: Partial<SessionCreationPreferences>) => {
      const currentPreferences = get().preferences;
      const newPreferences: SessionCreationPreferences = {
        ...currentPreferences,
        ...updates,
        selectedTools: {
          ...currentPreferences.selectedTools,
          ...updates.selectedTools
        },
        claudeConfig: {
          ...currentPreferences.claudeConfig,
          ...updates.claudeConfig
        },
        sessionCount: defaultPreferences.sessionCount
      };
      const saveRevision = ++revision;
      set({ preferences: newPreferences, error: null });

      // Serialize full snapshots so an older request cannot overwrite a newer
      // edit on the backend. Keep newer optimistic edits visible during failures.
      saveQueue = saveQueue.then(async () => {
        try {
          const response = await API.config.updateSessionPreferences(newPreferences);
          if (!response.success) throw new Error(response.error || 'Failed to save preferences');
          savedPreferences = newPreferences;
        } catch (error) {
          if (saveRevision === revision) {
            set({
              preferences: savedPreferences,
              error: error instanceof Error ? error.message : 'Failed to save preferences'
            });
          }
        }
      });
      return saveQueue;
    }
  };
});
