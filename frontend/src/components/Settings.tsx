import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { Button } from './ui/Button';
import { Bone, Skeleton, SkeletonSwap, TextBone, LoadingStatus } from './ui/Skeleton';
import { ConfirmDialog } from './ConfirmDialog';
import { SettingsLayout } from './settings/SettingsLayout';
import { GeneralSettings } from './settings/categories/GeneralSettings';
import { AppearanceSettings } from './settings/categories/AppearanceSettings';
import { TerminalSettings } from './settings/categories/TerminalSettings';
import { LinksSettings } from './settings/categories/LinksSettings';
import { AIAgentsSettings } from './settings/categories/AIAgentsSettings';
import { AgentsSettings } from './settings/categories/AgentsSettings';
import { WorktreesGitSettings } from './settings/categories/WorktreesGitSettings';
import { MachineHealthSettings } from './settings/categories/MachineHealthSettings';
import { NotificationSettings } from './NotificationSettings';
import { NotifySettings } from './settings/categories/NotifySettings';
import { RemoteAccessSettings } from './settings/categories/RemoteAccessSettings';
import { IntegrationsSettings } from './settings/categories/IntegrationsSettings';
import { DevicesSettings } from './settings/categories/DevicesSettings';
import { BrowserSettings } from './settings/categories/BrowserSettings';
import { SecretsSettings } from './settings/categories/SecretsSettings';
import { ShortcutsSettings } from './settings/categories/ShortcutsSettings';
import { PrivacySettings } from './settings/categories/PrivacySettings';
import { ImportExportSettings } from './settings/categories/ImportExportSettings';
import { AdvancedSettings } from './settings/categories/AdvancedSettings';
import { AutopilotSettings } from './settings/categories/AutopilotSettings';
import { UsageView, type UsageTab } from './usage/UsageView';
import { RemoteAccessWorkflows } from './settings/RemoteAccessWorkflows';
import { MachineDetails } from './settings/MachineDetails';
import { PaneCloudMachinePage } from './settings/PaneCloudMachineGroups';
import { PANE_CLOUD_MACHINE } from '../../../shared/utils/paneCloudMachine';
import { useSettingsPersistence } from './settings/useSettingsPersistence';
import { useDirtySettingsForms } from './settings/useDirtySettingsForms';
import { registerSettingsExit } from '../utils/settingsExit';
import { useRemoteAccessSettings } from './settings/useRemoteAccessSettings';
import { SETTINGS_CATEGORIES, settingDomId } from './settings/catalog';
import { useAutopilotStore } from '../stores/autopilotStore';
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

const SETTINGS_WITHOUT_AUTOPILOT = SETTINGS_CATEGORIES.filter((item) => item.id !== 'autopilot');

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
  /** A setting on Remote Access a link asked for; Remote Access opens the tab that holds it. */
  const [remoteSettingRequest, setRemoteSettingRequest] = useState<{ setting: SettingsSettingId; nonce: number }>();
  /** Usage & Limits opens on this tab; a request for its leaderboard sets it. */
  const [usageTab, setUsageTab] = useState<UsageTab>('usage');
  // Remote Access › Machine details: the machine shown, while open.
  const [remoteMachineId, setRemoteMachineId] = useState<string>();
  const [passwordRequest, setPasswordRequest] = useState<{ machine: string; nonce: number }>();
  const passwordNonce = useRef(0);
  // A request opens its field once; leaving the page drops it so coming back starts closed.
  const clearRemoteRequests = useCallback(() => {
    setRemoteSettingRequest(undefined);
    setPasswordRequest(undefined);
  }, []);
  const openMachineDetails = useCallback((machineId: string) => {
    clearRemoteRequests();
    setRemoteMachineId(machineId);
  }, [clearRemoteRequests]);
  const askMachinePassword = useCallback((machine: string) => {
    passwordNonce.current += 1;
    setPasswordRequest({ machine, nonce: passwordNonce.current });
    setRemoteMachineId(undefined);
  }, []);
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
      setRemoteMachineId(undefined);
      const { category: requestedCategory, setting } = openRequest.target;
      setRemoteSettingRequest(requestedCategory === 'remote-access' && setting ? { setting, nonce: openRequest.nonce } : undefined);
      setUsageTab(openRequest.target.setting === 'usage-leaderboard' ? 'leaderboard' : 'usage');
      if (openRequest.target.machine) askMachinePassword(openRequest.target.machine);
      // A machine's password field takes focus itself once its row is listed.
      if (!openRequest.target.machine) focusSetting(openRequest.target.setting);
    });
    onOpenRequestHandled();
  }, [askMachinePassword, focusSetting, isOpen, onCategoryChange, onOpenRequestHandled, openRequest, requestTransition]);

  const changeCategory = useCallback((nextCategory: SettingsCategoryId) => {
    if (nextCategory === category && !remoteSubview && !remoteMachineId) return;
    requestTransition(() => {
      setRemoteSubview(undefined);
      setRemoteMachineId(undefined);
      clearRemoteRequests();
      setUsageTab('usage');
      onCategoryChange(nextCategory);
    });
  }, [category, clearRemoteRequests, onCategoryChange, remoteMachineId, remoteSubview, requestTransition]);

  const requestClose = useCallback(() => {
    requestTransition(() => {
      setRemoteSubview(undefined);
      setRemoteMachineId(undefined);
      clearRemoteRequests();
      onClose();
    });
  }, [clearRemoteRequests, onClose, requestTransition]);

  // Search leaves Settings before it opens a Pane, Session or project, through the unsaved-edits guard.
  useEffect(() => registerSettingsExit(then => requestTransition(() => {
    setRemoteSubview(undefined);
    setRemoteMachineId(undefined);
    clearRemoteRequests();
    onClose();
    then();
  })), [clearRemoteRequests, onClose, requestTransition]);

  const showKeyboardShortcuts = useCallback(() => {
    requestTransition(onShowKeyboardShortcuts);
  }, [onShowKeyboardShortcuts, requestTransition]);

  const showUpdate = useCallback((versionInfo: VersionInfo) => {
    requestTransition(() => {
      setRemoteSubview(undefined);
      setRemoteMachineId(undefined);
      clearRemoteRequests();
      onClose();
      onUpdate(versionInfo);
    });
  }, [clearRemoteRequests, onClose, onUpdate, requestTransition]);

  const openRemoteSubview = useCallback((subview: RemoteAccessSubviewId) => {
    requestTransition(() => {
      clearRemoteRequests();
      setRemoteSubview(subview);
    });
  }, [clearRemoteRequests, requestTransition]);

  // Settings › Autopilot shows only while Autopilot is on (Advanced › Experimental).
  const autopilotOn = useAutopilotStore((state) => state.snapshot?.enabled === true);
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
      case 'links':
        return <LinksSettings persistence={persistence} {...sharedDirtyProps} />;
      case 'ai-agents':
        return <AIAgentsSettings persistence={persistence} {...sharedDirtyProps} />;
      case 'agents':
        return <AgentsSettings />;
      case 'usage':
        return <UsageView key={usageTab} initialTab={usageTab} />;
      case 'worktrees-git':
        return <WorktreesGitSettings persistence={persistence} {...sharedDirtyProps} />;
      case 'machine-health':
        return <MachineHealthSettings persistence={persistence} />;
      case 'notify':
        return <NotifySettings persistence={persistence} />;
      case 'autopilot':
        return <AutopilotSettings {...sharedDirtyProps} />;
      case 'notifications':
        return <NotificationSettings persistence={persistence} />;
      case 'remote-access':
        if (remoteSubview) {
          return <RemoteAccessWorkflows subview={remoteSubview} controller={remote} onBack={() => requestTransition(() => setRemoteSubview(undefined))} {...sharedDirtyProps} />;
        }
        if (remoteMachineId === PANE_CLOUD_MACHINE.id) {
          return <PaneCloudMachinePage onBack={() => setRemoteMachineId(undefined)} />;
        }
        if (remoteMachineId) {
          return <MachineDetails machineId={remoteMachineId} controller={remote} onBack={() => setRemoteMachineId(undefined)} onNeedsPassword={askMachinePassword} />;
        }
        return (
          <RemoteAccessSettings
            controller={remote}
            onOpenSubview={openRemoteSubview}
            onOpenMachine={openMachineDetails}
            settingRequest={remoteSettingRequest}
            passwordRequest={passwordRequest}
          />
        );
      case 'integrations':
        return <IntegrationsSettings persistence={persistence} {...sharedDirtyProps} />;
      case 'secrets':
        return <SecretsSettings />;
      case 'devices':
        return <DevicesSettings />;
      case 'browser':
        return <BrowserSettings persistence={persistence} />;
      case 'shortcuts':
        return <ShortcutsSettings persistence={persistence} platform={platform} onShowKeyboardShortcuts={showKeyboardShortcuts} {...sharedDirtyProps} />;
      case 'privacy':
        return <PrivacySettings persistence={persistence} />;
      case 'import-export':
        return <ImportExportSettings persistence={persistence} platform={platform} />;
      case 'advanced':
        return <AdvancedSettings persistence={persistence} platform={platform} {...sharedDirtyProps} />;
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div data-testid="settings-page" data-pane-part="settings" className="flex h-full min-h-0 w-full flex-col bg-bg-primary">
        <div className="pane-drag-area h-[38px] flex-shrink-0 bg-surface-secondary" />
        {!persistence.config && persistence.configError && !persistence.isLoading ? (
          <div className="relative flex min-h-0 flex-1 items-center justify-center">
            <button type="button" onClick={requestClose} className="absolute left-3 top-3 inline-flex h-7 items-center gap-1.5 rounded px-2 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text-primary">
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
            <div className="flex flex-col items-center gap-3 p-6 text-center">
              <AlertCircle className="h-6 w-6 text-status-error" />
              <p className="max-w-md text-sm text-status-error" role="alert">{persistence.configError}</p>
              <Button type="button" variant="secondary" size="sm" onClick={() => void persistence.fetchConfig()}>Retry</Button>
            </div>
          </div>
        ) : (
          <SettingsLayout category={category} categories={autopilotOn ? SETTINGS_CATEGORIES : SETTINGS_WITHOUT_AUTOPILOT} onCategoryChange={changeCategory} onBack={requestClose} fullBleed={category === 'usage'}>
            <SkeletonSwap loading={!persistence.config} skeleton={<SettingsPageSkeleton title={SETTINGS_CATEGORIES.find((item) => item.id === category)?.label ?? 'Settings'} />}>
              {persistence.config && content()}
            </SkeletonSwap>
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

/** A settings page while its config loads: the SettingsPage header, then one section of SettingRows. */
function SettingsPageSkeleton({ title }: { title: string }) {
  return (
    <section className="mx-auto w-full max-w-3xl pb-8">
      <LoadingStatus label="Loading settings" />
      <Skeleton>
        <header className="mb-7">
          <h2 className="text-xl font-semibold leading-7"><TextBone text={title} /></h2>
          <div className="mt-1.5 flex h-5 items-center"><Bone className="h-3.5 w-[min(28rem,80%)]" /></div>
        </header>
        <div className="space-y-1">
          <div className="border-b border-border-secondary pb-2">
            <div className="flex h-5 items-center"><Bone className="h-3.5 w-28" /></div>
            <div className="mt-1 flex h-4 items-center"><Bone className="h-3 w-72 max-w-full" /></div>
          </div>
          <div className="space-y-4 divide-y divide-border-secondary">
            {[[40, 78], [32, 64], [46, 70]].map(([label, description]) => (
              <div key={label} className="grid gap-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(180px,auto)] sm:items-center">
                <div className="min-w-0">
                  <div className="flex h-5 items-center"><Bone className="h-3.5" style={{ width: `${label}%` }} /></div>
                  <div className="mt-1 flex h-[19.5px] items-center"><Bone className="h-3" style={{ width: `${description}%` }} /></div>
                </div>
                <div className="flex justify-end"><Bone className="h-6 w-11 rounded-full" /></div>
              </div>
            ))}
          </div>
        </div>
      </Skeleton>
    </section>
  );
}
