import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, RefreshCw } from 'lucide-react';
import { Button } from './ui/Button';
import { ConfirmDialog } from './ConfirmDialog';
import { SettingsLayout } from './settings/SettingsLayout';
import { GeneralSettings } from './settings/categories/GeneralSettings';
import { AppearanceSettings } from './settings/categories/AppearanceSettings';
import { TerminalSettings } from './settings/categories/TerminalSettings';
import { AIAgentsSettings } from './settings/categories/AIAgentsSettings';
import { WorktreesGitSettings } from './settings/categories/WorktreesGitSettings';
import { NotificationSettings } from './NotificationSettings';
import { RemoteAccessSettings } from './settings/categories/RemoteAccessSettings';
import { IntegrationsSettings } from './settings/categories/IntegrationsSettings';
import { ShortcutsSettings } from './settings/categories/ShortcutsSettings';
import { PrivacySettings } from './settings/categories/PrivacySettings';
import { AdvancedSettings } from './settings/categories/AdvancedSettings';
import { UsageView } from './usage/UsageView';
import { RemoteAccessWorkflows } from './settings/RemoteAccessWorkflows';
import { useSettingsPersistence } from './settings/useSettingsPersistence';
import { useDirtySettingsForms } from './settings/useDirtySettingsForms';
import { useRemoteAccessSettings } from './settings/useRemoteAccessSettings';
import { SETTINGS_CATEGORIES, settingDomId } from './settings/catalog';
import type {
  RemoteAccessSubviewId,
  SettingsCategoryId,
  SettingsOpenRequest,
  SettingsSettingId,
} from '../types/settings';
import type { VersionInfo } from '../types/session';


interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  category: SettingsCategoryId;
  onCategoryChange: (category: SettingsCategoryId) => void;
  openRequest?: SettingsOpenRequest;
  onOpenRequestHandled: () => void;
  onShowKeyboardShortcuts: () => void;
  onUpdate: (versionInfo: VersionInfo) => void;
  onSendFeedback: () => void;
}

/** How long an opened Settings link waits for its row to render. */
const SETTING_FOCUS_WAIT_MS = 5000;
/** Where the user types in a settings row: a text box, not its buttons, toggles or choices. */
const SETTING_TEXT_FIELD = 'textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])';

export function Settings({ isOpen, onClose, category, onCategoryChange, openRequest, onOpenRequestHandled, onShowKeyboardShortcuts, onUpdate, onSendFeedback }: SettingsProps) {
  const persistence = useSettingsPersistence(isOpen);
  const dirtyForms = useDirtySettingsForms();
  const {
    setDirty,
    requestTransition,
    confirmOpen,
    discardAndContinue,
    stay,
  } = dirtyForms;
  const [platform, setPlatform] = useState('darwin');
  const [systemMonoFonts, setSystemMonoFonts] = useState<string[]>([]);
  const [remoteSubview, setRemoteSubview] = useState<RemoteAccessSubviewId | undefined>();
  const handledRequestRef = useRef<number | null>(null);
  const fontsLoadedRef = useRef(false);
  const remote = useRemoteAccessSettings(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return;
    void window.electronAPI.getPlatform().then(setPlatform);
    if (!fontsLoadedRef.current) {
      fontsLoadedRef.current = true;
      void window.electronAPI.config.getMonospaceFonts().then((response) => {
        if (response.success && Array.isArray(response.data)) {
          // SAFETY: The named IPC/API channel contract establishes this response payload type.
          setSystemMonoFonts(response.data as string[]);
        }
      }).catch(() => undefined);
    }
  }, [isOpen]);

  // Some rows render only once their data loads (the cloud sandbox rows wait for the cloud
  // library), so wait for the row to appear rather than looking for it once.
  const stopFocusWaitRef = useRef<(() => void) | null>(null);
  const focusSetting = useCallback((setting?: SettingsSettingId) => {
    stopFocusWaitRef.current?.();
    stopFocusWaitRef.current = null;
    if (!setting) return;
    // The field the user came to fill in gets focus; a row without one is focused itself. A field that
    // is still disabled (its value loading) is waited for.
    const focus = (settle: boolean) => {
      const row = document.getElementById(settingDomId(setting));
      if (!row) return false;
      const field = row.querySelector<HTMLElement>(SETTING_TEXT_FIELD);
      if (field?.matches(':disabled') && !settle) return false;
      row.scrollIntoView({ block: 'center' });
      (field && !field.matches(':disabled') ? field : row).focus({ preventScroll: true });
      return true;
    };
    const observer = new MutationObserver(() => {
      if (focus(false)) stop();
    });
    const timeout = window.setTimeout(() => {
      focus(true);
      stop();
    }, SETTING_FOCUS_WAIT_MS);
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      if (stopFocusWaitRef.current === stop) stopFocusWaitRef.current = null;
    };
    stopFocusWaitRef.current = stop;
    // The category switch renders first; a row already there is focused on the next frame.
    window.requestAnimationFrame(() => {
      if (stopFocusWaitRef.current !== stop) return;
      if (focus(false)) stop();
      else observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    });
  }, []);

  // Settings mounts when it opens, and StrictMode remounts it at once in development: cancelling the wait on
  // unmount must let the remount handle the same open request again, or its field never gets focus.
  useEffect(() => () => {
    stopFocusWaitRef.current?.();
    handledRequestRef.current = null;
  }, []);

  useEffect(() => {
    if (!isOpen || !openRequest || handledRequestRef.current === openRequest.nonce) return;
    handledRequestRef.current = openRequest.nonce;
    requestTransition(() => {
      onCategoryChange(openRequest.target.category);
      setRemoteSubview(openRequest.target.subview);
      focusSetting(openRequest.target.setting);
    });
    onOpenRequestHandled();
  }, [focusSetting, isOpen, onCategoryChange, onOpenRequestHandled, openRequest, requestTransition]);

  const changeCategory = useCallback((nextCategory: SettingsCategoryId) => {
    if (nextCategory === category && !remoteSubview) return;
    requestTransition(() => {
      setRemoteSubview(undefined);
      onCategoryChange(nextCategory);
    });
  }, [category, onCategoryChange, remoteSubview, requestTransition]);

  const requestClose = useCallback(() => {
    requestTransition(() => {
      setRemoteSubview(undefined);
      onClose();
    });
  }, [onClose, requestTransition]);

  const showKeyboardShortcuts = useCallback(() => {
    requestTransition(onShowKeyboardShortcuts);
  }, [onShowKeyboardShortcuts, requestTransition]);

  const showUpdate = useCallback((versionInfo: VersionInfo) => {
    requestTransition(() => {
      setRemoteSubview(undefined);
      onClose();
      onUpdate(versionInfo);
    });
  }, [onClose, onUpdate, requestTransition]);

  const openRemoteSubview = useCallback((subview: RemoteAccessSubviewId) => {
    requestTransition(() => setRemoteSubview(subview));
  }, [requestTransition]);

  const content = () => {
    if (!persistence.config) return null;
    const sharedDirtyProps = { onDirtyChange: setDirty };
    switch (category) {
      case 'general':
        // onSendFeedback is passed straight through, unlike showUpdate/showKeyboardShortcuts:
        // the feedback dialog stacks on top of Settings instead of replacing it, so there is
        // no transition to guard and closing Settings would strand focus on an unmounted button.
        return <GeneralSettings persistence={persistence} onUpdate={showUpdate} onSendFeedback={onSendFeedback} />;
      case 'appearance':
        return <AppearanceSettings persistence={persistence} />;
      case 'terminal':
        return <TerminalSettings persistence={persistence} systemMonoFonts={systemMonoFonts} />;
      case 'ai-agents':
        return <AIAgentsSettings persistence={persistence} {...sharedDirtyProps} />;
      case 'usage':
        return <UsageView />;
      case 'worktrees-git':
        return <WorktreesGitSettings persistence={persistence} {...sharedDirtyProps} />;
      case 'notifications':
        return <NotificationSettings persistence={persistence} />;
      case 'remote-access':
        return remoteSubview
          ? <RemoteAccessWorkflows subview={remoteSubview} controller={remote} onBack={() => requestTransition(() => setRemoteSubview(undefined))} {...sharedDirtyProps} />
          : <RemoteAccessSettings controller={remote} onOpenSubview={openRemoteSubview} />;
      case 'integrations':
        return <IntegrationsSettings persistence={persistence} {...sharedDirtyProps} />;
      case 'shortcuts':
        return <ShortcutsSettings persistence={persistence} onShowKeyboardShortcuts={showKeyboardShortcuts} {...sharedDirtyProps} />;
      case 'privacy':
        return <PrivacySettings persistence={persistence} />;
      case 'advanced':
        return <AdvancedSettings persistence={persistence} platform={platform} {...sharedDirtyProps} />;
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div data-testid="settings-page" className="flex h-full min-h-0 w-full flex-col bg-bg-primary">
        <div className="pane-drag-area h-[38px] flex-shrink-0 bg-surface-secondary" />
        {!persistence.config && (persistence.isLoading || persistence.configError) ? (
          <div className="relative flex min-h-0 flex-1 items-center justify-center">
            <button type="button" onClick={requestClose} className="absolute left-3 top-3 inline-flex h-7 items-center gap-1.5 rounded px-2 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text-primary">
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
            {persistence.isLoading ? (
              <div className="flex items-center text-sm text-text-tertiary" aria-live="polite">
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Loading settings
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 p-6 text-center">
                <AlertCircle className="h-6 w-6 text-status-error" />
                <p className="max-w-md text-sm text-status-error" role="alert">{persistence.configError}</p>
                <Button type="button" variant="secondary" size="sm" onClick={() => void persistence.fetchConfig()}>Retry</Button>
              </div>
            )}
          </div>
        ) : (
          <SettingsLayout category={category} categories={SETTINGS_CATEGORIES} onCategoryChange={changeCategory} onBack={requestClose} fullBleed={category === 'usage'}>
            {content()}
          </SettingsLayout>
        )}
      </div>
      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={stay}
        onConfirm={discardAndContinue}
        title="Discard unsaved changes?"
        message="This form has changes that have not been applied. Discard them and continue?"
        confirmText="Discard Changes"
        cancelText="Stay"
        variant="warning"
      />
    </>
  );
}
