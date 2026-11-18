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
  resetPreferences: () => void;
}

export const useSessionPreferencesStore = create<SessionPreferencesStore>((set, get) => ({
  preferences: defaultPreferences,
  isLoading: false,
  error: null,

  loadPreferences: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await API.config.getSessionPreferences();
      if (response.success && response.data) {
        // Merge with defaults to ensure all fields are present
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
          }
        };
        mergedPreferences.sessionCount = defaultPreferences.sessionCount;
        set({ preferences: mergedPreferences, isLoading: false });
      } else {
        set({ error: response.error || 'Failed to load session preferences', isLoading: false });
      }
    } catch {
      set({ error: 'Failed to load session preferences', isLoading: false });
    }
  },

  updatePreferences: async (updates: Partial<SessionCreationPreferences>) => {
    const allowedUpdates = { ...updates };
    delete allowedUpdates.sessionCount;
    const currentPreferences = get().preferences;
    
    // Deep merge the updates while keeping session count at its default
    const newPreferences: SessionCreationPreferences = {
      ...currentPreferences,
      ...allowedUpdates,
      selectedTools: {
        ...currentPreferences.selectedTools,
        ...allowedUpdates.selectedTools
      },
      claudeConfig: {
        ...currentPreferences.claudeConfig,
        ...allowedUpdates.claudeConfig
      },
      sessionCount: defaultPreferences.sessionCount
    };

    // Update local state immediately
    set({ preferences: newPreferences });

    // Save to backend
    try {
      const response = await API.config.updateSessionPreferences(newPreferences);
      if (!response.success) {
        // Revert on failure
        set({ preferences: currentPreferences, error: response.error || 'Failed to save preferences' });
      }
    } catch {
      // Revert on failure
      set({ preferences: currentPreferences, error: 'Failed to save preferences' });
    }
  },

  resetPreferences: () => {
    set({ preferences: defaultPreferences });
  }
}));
