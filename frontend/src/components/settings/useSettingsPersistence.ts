import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '../../utils/api';
import type { UpdateConfigRequest } from '../../types/config';
import {
  DEFAULT_SETTINGS_PREFERENCES,
  SETTINGS_PREFERENCE_KEYS,
  parseSettingsPreferences,
  serializeSettingPreference,
  type SettingSaveState,
  type SettingsPreferenceValues,
  type SettingsSettingId,
} from '../../types/settings';
import { useConfigStore } from '../../stores/configStore';

type PreferenceName = keyof SettingsPreferenceValues;

const PREFERENCE_KEY_BY_NAME = {
  autoRenameSessionsToPr: SETTINGS_PREFERENCE_KEYS.autoRenameSessionsToPr,
  sidebarPaneRowLayout: SETTINGS_PREFERENCE_KEYS.sidebarPaneRowLayout,
  atTerminalPasteMode: SETTINGS_PREFERENCE_KEYS.atTerminalPasteMode,
  atTerminalLineCount: SETTINGS_PREFERENCE_KEYS.atTerminalLineCount,
} satisfies Record<PreferenceName, string>;

const PREFERENCE_SETTING_ID = {
  autoRenameSessionsToPr: 'auto-rename-pr',
  sidebarPaneRowLayout: 'sidebar-pane-rows',
  atTerminalPasteMode: 'terminal-reference-paste-mode',
  atTerminalLineCount: 'terminal-reference-line-count',
} satisfies Record<PreferenceName, SettingsSettingId>;

export function useSettingsPersistence(isOpen: boolean) {
  const { config, isLoading, error: configError, fetchConfig, updateConfig } = useConfigStore();
  const [saveStates, setSaveStates] = useState<Partial<Record<SettingsSettingId, SettingSaveState>>>({});
  const [preferences, setPreferences] = useState(DEFAULT_SETTINGS_PREFERENCES);
  const [preferencesLoading, setPreferencesLoading] = useState(false);
  const savedTimers = useRef(new Map<SettingsSettingId, number>());

  const setSaveState = useCallback((settingId: SettingsSettingId, state: SettingSaveState) => {
    const existingTimer = savedTimers.current.get(settingId);
    if (existingTimer) window.clearTimeout(existingTimer);
    setSaveStates((current) => ({ ...current, [settingId]: state }));
    if (state.state === 'saved') {
      const timer = window.setTimeout(() => {
        setSaveStates((current) => ({ ...current, [settingId]: { state: 'idle' } }));
        savedTimers.current.delete(settingId);
      }, 1800);
      savedTimers.current.set(settingId, timer);
    }
  }, []);

  const loadPreferences = useCallback(async () => {
    setPreferencesLoading(true);
    try {
      setPreferences(parseSettingsPreferences(await API.preferences.getAll()));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load preferences';
      for (const settingId of Object.values(PREFERENCE_SETTING_ID)) {
        setSaveState(settingId, { state: 'error', message });
      }
    } finally {
      setPreferencesLoading(false);
    }
  }, [setSaveState]);

  useEffect(() => {
    if (!isOpen) return;
    void fetchConfig().catch(() => undefined);
    void loadPreferences();
  }, [fetchConfig, isOpen, loadPreferences]);

  useEffect(() => () => {
    for (const timer of savedTimers.current.values()) window.clearTimeout(timer);
    savedTimers.current.clear();
  }, []);

  const saveConfig = useCallback(async (
    settingId: SettingsSettingId,
    patch: UpdateConfigRequest,
  ): Promise<boolean> => {
    setSaveState(settingId, { state: 'saving' });
    try {
      await updateConfig(patch);
      setSaveState(settingId, { state: 'saved' });
      return true;
    } catch (error) {
      await fetchConfig().catch(() => undefined);
      setSaveState(settingId, {
        state: 'error',
        message: error instanceof Error ? error.message : 'Failed to save setting',
      });
      return false;
    }
  }, [fetchConfig, setSaveState, updateConfig]);

  const runSave = useCallback(async (
    settingId: SettingsSettingId,
    work: () => Promise<void>,
  ): Promise<boolean> => {
    setSaveState(settingId, { state: 'saving' });
    try {
      await work();
      setSaveState(settingId, { state: 'saved' });
      return true;
    } catch (error) {
      setSaveState(settingId, {
        state: 'error',
        message: error instanceof Error ? error.message : 'Failed to save setting',
      });
      return false;
    }
  }, [setSaveState]);

  const savePreference = useCallback(async <K extends PreferenceName>(
    name: K,
    value: SettingsPreferenceValues[K],
  ): Promise<boolean> => {
    const settingId = PREFERENCE_SETTING_ID[name];
    setSaveState(settingId, { state: 'saving' });
    try {
      await API.preferences.set(PREFERENCE_KEY_BY_NAME[name], serializeSettingPreference(name, value));
      setPreferences((current) => ({ ...current, [name]: value }));
      if (name === 'sidebarPaneRowLayout') {
        window.dispatchEvent(new CustomEvent('sidebar-pane-row-layout-changed', { detail: { layout: value } }));
      }
      setSaveState(settingId, { state: 'saved' });
      return true;
    } catch (error) {
      await loadPreferences();
      setSaveState(settingId, {
        state: 'error',
        message: error instanceof Error ? error.message : 'Failed to save preference',
      });
      return false;
    }
  }, [loadPreferences, setSaveState]);

  return {
    config,
    isLoading,
    configError,
    fetchConfig,
    saveConfig,
    runSave,
    saveStates,
    reportSaveError: (settingId: SettingsSettingId, message: string) => setSaveState(settingId, { state: 'error', message }),
    preferences,
    preferencesLoading,
    savePreference,
  };
}

export type SettingsPersistence = ReturnType<typeof useSettingsPersistence>;
