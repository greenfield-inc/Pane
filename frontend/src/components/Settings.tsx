import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import { Modal, ModalHeader } from './ui/Modal';
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
import { UsageSettings } from './settings/categories/UsageSettings';
import { RemoteAccessWorkflows } from './settings/RemoteAccessWorkflows';
import { useSettingsPersistence } from './settings/useSettingsPersistence';
import { useDirtySettingsForms } from './settings/useDirtySettingsForms';
import { useRemoteAccessSettings } from './settings/useRemoteAccessSettings';
import { SETTINGS_CATEGORIES, SETTINGS_CATEGORIES_WITHOUT_USAGE, settingDomId } from './settings/catalog';
import type {
  RemoteAccessSubviewId,
  SettingsCategoryId,
  SettingsOpenRequest,
  SettingsSettingId,
} from '../types/settings';
import type { PreferredShell } from '../types/config';
import type { VersionInfo } from '../types/session';
import { API } from '../utils/api';

interface AvailableShell {
  id: PreferredShell;
  name: string;
  path: string;
}

/** Whether the host probe found a Codex login; the Usage tab is rendered only when 'available'. */
type CodexUsageDetection = 'unknown' | 'available' | 'unavailable';

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
  const [availableShells, setAvailableShells] = useState<AvailableShell[]>([]);
  const [systemMonoFonts, setSystemMonoFonts] = useState<string[]>([]);
  const [remoteSubview, setRemoteSubview] = useState<RemoteAccessSubviewId | undefined>();
  const [codexUsageDetection, setCodexUsageDetection] = useState<CodexUsageDetection>('unknown');
  const handledRequestRef = useRef<number | null>(null);
  const fontsLoadedRef = useRef(false);
  const remote = useRemoteAccessSettings(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return;
    void window.electronAPI.getPlatform().then(async (currentPlatform) => {
      setPlatform(currentPlatform);
      if (currentPlatform === 'win32') {
        const response = await API.config.getAvailableShells();
        if (response.success && Array.isArray(response.data)) {
          // SAFETY: The named IPC/API channel contract establishes this response payload type.
          setAvailableShells(response.data as AvailableShell[]);
        }
      }
    });
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

  // Show the Usage tab when Codex transcripts have been indexed (rate limits exist).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void API.usage.getReport({ providers: ['codex'] }).then((response) => {
      if (cancelled) return;
      const hasLimits = response.success && (response.data?.rateLimits.length ?? 0) > 0;
      setCodexUsageDetection(hasLimits ? 'available' : 'unavailable');
    }).catch(() => {
      if (!cancelled) setCodexUsageDetection('unavailable');
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const visibleCategories = codexUsageDetection === 'available'
    ? SETTINGS_CATEGORIES
    : SETTINGS_CATEGORIES_WITHOUT_USAGE;

  // A remembered Usage category with no Codex login falls back to General.
  useEffect(() => {
    if (isOpen && category === 'usage' && codexUsageDetection === 'unavailable') onCategoryChange('general');
  }, [category, codexUsageDetection, isOpen, onCategoryChange]);

  const focusSetting = useCallback((setting?: SettingsSettingId) => {
    if (!setting) return;
    window.setTimeout(() => {
      const element = document.getElementById(settingDomId(setting));
      element?.scrollIntoView({ block: 'center' });
      element?.focus({ preventScroll: true });
    }, 100);
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
        return <TerminalSettings persistence={persistence} platform={platform} availableShells={availableShells} systemMonoFonts={systemMonoFonts} />;
      case 'ai-agents':
        return <AIAgentsSettings persistence={persistence} {...sharedDirtyProps} />;
      case 'usage':
        return <UsageSettings />;
      case 'worktrees-git':
        return <WorktreesGitSettings persistence={persistence} {...sharedDirtyProps} />;
      case 'notifications':
        return <NotificationSettings persistence={persistence} />;
      case 'remote-access':
        return remoteSubview
          ? <RemoteAccessWorkflows subview={remoteSubview} controller={remote} onBack={() => requestTransition(() => setRemoteSubview(undefined))} {...sharedDirtyProps} />
          : <RemoteAccessSettings controller={remote} onOpenSubview={openRemoteSubview} closeSettings={onClose} />;
      case 'integrations':
        return <IntegrationsSettings persistence={persistence} {...sharedDirtyProps} />;
      case 'shortcuts':
        return <ShortcutsSettings persistence={persistence} platform={platform} onShowKeyboardShortcuts={showKeyboardShortcuts} {...sharedDirtyProps} />;
      case 'privacy':
        return <PrivacySettings persistence={persistence} />;
      case 'advanced':
        return <AdvancedSettings persistence={persistence} platform={platform} {...sharedDirtyProps} />;
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={requestClose}
        size="full"
        showCloseButton={false}
        className="mx-auto h-[calc(100vh-4rem)] min-h-[560px] max-h-[760px] max-w-6xl"
      >
        <ModalHeader title="Pane Settings" icon={<SettingsIcon className="h-5 w-5" />} onClose={requestClose} />
        {persistence.isLoading && !persistence.config ? (
          <div className="flex min-h-[420px] items-center justify-center text-sm text-text-tertiary" aria-live="polite">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Loading settings
          </div>
        ) : persistence.configError && !persistence.config ? (
          <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 p-6 text-center">
            <AlertCircle className="h-6 w-6 text-status-error" />
            <p className="max-w-md text-sm text-status-error" role="alert">{persistence.configError}</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void persistence.fetchConfig()}>Retry</Button>
          </div>
        ) : (
          <SettingsLayout category={category} categories={visibleCategories} onCategoryChange={changeCategory}>
            {content()}
          </SettingsLayout>
        )}
      </Modal>
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
