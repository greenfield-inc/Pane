import { create } from 'zustand';
import { API } from '../utils/api';
import type { AppConfig, UpdateConfigRequest } from '../types/config';

interface ConfigStore {
  config: AppConfig | null;
  isLoading: boolean;
  error: string | null;
  fetchConfig: (ownsRequest?: () => boolean) => Promise<AppConfig>;
  updateConfig: (updates: UpdateConfigRequest) => Promise<AppConfig>;
}

export function areKeyboardShortcutsEnabled(config: AppConfig | null): boolean {
  return config !== null && config.keyboardShortcutsEnabled !== false;
}

export function isCommandPaletteShortcutEnabled(config: AppConfig | null): boolean {
  return config !== null && (
    config.keyboardShortcutsEnabled !== false
    || config.commandPaletteShortcutEnabled !== false
  );
}

export const useConfigStore = create<ConfigStore>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,

  fetchConfig: async (ownsRequest = () => true) => {
    if (ownsRequest()) set({ isLoading: true, error: null });
    try {
      const response = await API.config.get();
      if (response.success && response.data) {
        if (ownsRequest()) set({ config: response.data, isLoading: false });
        return response.data;
      } else {
        const message = response.error || 'Failed to fetch config';
        if (ownsRequest()) set({ error: message, isLoading: false });
        throw new Error(message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch config';
      if (ownsRequest()) set({ error: message, isLoading: false });
      throw new Error(message);
    }
  },

  updateConfig: async (updates: UpdateConfigRequest) => {
    try {
      const response = await API.config.update(updates);
      if (response.success && response.data) {
        set({ config: response.data, error: null });
        return response.data;
      } else {
        const msg = response.error || 'Failed to update config';
        set({ error: msg });
        throw new Error(msg);
      }
    } catch (error) {
      if (error instanceof Error && get().error) {
        // Already set above — re-throw so callers can react
        throw error;
      }
      set({ error: 'Failed to update config' });
      throw new Error('Failed to update config');
    }
  },
}));
