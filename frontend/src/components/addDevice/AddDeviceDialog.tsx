import { useEffect, useState } from 'react';
import { Glasses, Laptop, Smartphone, SquareTerminal } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { Modal, ModalBody } from '../ui/Modal';
import { useRelayPairing } from '../../hooks/useRelayPairing';
import { DEFAULT_RELAY_DOMAIN } from '../../../../shared/remoteClient/relay';
import type { RelayStatus } from '../../../../shared/types/relay';
import { cn } from '../../utils/cn';
import { startAddDeviceListeners, useAddDeviceStore, type AddDeviceTab } from './addDeviceStore';
import { PhoneTab } from './PhoneTab';
import { ComputerTab } from './ComputerTab';
import { SshTab } from './SshTab';
import { WearablesTab } from './WearablesTab';
import { LinkConfirmPage } from './LinkConfirm';
import { Tooltip } from '../ui/Tooltip';
import { requestOpenSettings } from '../../utils/openSettings';
import { RelayLimitTip } from './RelayLimitNotice';

const TABS: Array<{ id: AddDeviceTab; label: string; icon: typeof Smartphone }> = [
  { id: 'phone', label: 'Phone', icon: Smartphone },
  { id: 'computer', label: 'Computer', icon: Laptop },
  { id: 'ssh', label: 'SSH', icon: SquareTerminal },
  { id: 'wearables', label: 'Wearables', icon: Glasses },
];

/** The relay domain links and codes name: this computer's relay, or Pane's. */
function useRelayDomain(active: boolean): string {
  const [domain, setDomain] = useState(DEFAULT_RELAY_DOMAIN);
  useEffect(() => {
    if (!active) return;
    let live = true;
    window.electronAPI.invoke('relay:status').then(
      (status: RelayStatus) => { if (live && status.domain) setDomain(status.domain); },
      () => undefined,
    );
    return () => { live = false; };
  }, [active]);
  return domain;
}

/**
 * "Add a device": Phone, Computer, SSH and Wearables. Phone and Computer turn phone access on while
 * they show, since both hand out a relay link.
 */
export function AddDeviceDialog({ isOpen, tab, onTabChange, onClose }: {
  isOpen: boolean;
  tab: AddDeviceTab;
  onTabChange: (tab: AddDeviceTab) => void;
  onClose: () => void;
}) {
  const usesRelay = isOpen && (tab === 'phone' || tab === 'computer');
  const { view, ready, paired, renewal, retry } = useRelayPairing(usesRelay, tab === 'phone', isOpen);
  const domain = useRelayDomain(isOpen && tab === 'wearables');
  const limitUntil = view.step === 'limited' ? view.until : null;
  // Tailscale pairs devices without Pane relay's certificates, so it works while the relay is paused.
  const setUpTailscale = () => {
    onClose();
    requestOpenSettings({ category: 'remote-access', setting: 'remote-visibility' });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalBody className="space-y-5 px-6 py-5">
        <Dialog.Title className="text-heading-2 text-text-primary">Add a device</Dialog.Title>
        <div role="tablist" aria-label="Device kind" className="inline-flex gap-1 rounded-lg bg-surface-secondary p-1">
          {TABS.map(({ id, label, icon: Icon }) => {
            // Phone and Computer hand out relay links, which can't be used while the relay is paused.
            const paused = limitUntil !== null && (id === 'phone' || id === 'computer');
            const button = (
            <button
              key={id}
              type="button"
              role="tab"
              id={`add-device-tab-${id}`}
              aria-selected={tab === id}
              aria-controls="add-device-panel"
              onClick={() => onTabChange(id)}
              className={cn(
                'flex items-center gap-2 rounded-md px-4 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle',
                tab === id && 'bg-surface-hover font-medium',
                // A paused tab stays gray on hover too.
                paused ? 'text-text-disabled' : tab === id ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </button>
            );
            return paused ? <Tooltip key={id} content={<RelayLimitTip until={limitUntil} />}>{button}</Tooltip> : button;
          })}
        </div>
        <div role="tabpanel" id="add-device-panel" aria-labelledby={`add-device-tab-${tab}`}>
          {tab === 'phone' && <PhoneTab view={view} paired={paired} renewed={renewal !== null} onRetry={retry} onSetUpTailscale={setUpTailscale} />}
          {tab === 'computer' && (
            <ComputerTab
              ready={ready}
              error={view.step === 'error' ? view.message : null}
              onRetry={retry}
              limitUntil={limitUntil}
              onSetUpTailscale={setUpTailscale}
            />
          )}
          {tab === 'ssh' && <SshTab onClose={onClose} />}
          {tab === 'wearables' && <WearablesTab domain={domain} />}
        </div>
      </ModalBody>
    </Modal>
  );
}

/** Mounted once in the app shell: the dialog every "Add a device" button opens, and the page `pane://pair` links open on. */
export function AddDeviceHost() {
  const { isOpen, tab, setTab, close } = useAddDeviceStore();
  useEffect(() => startAddDeviceListeners(), []);
  return (
    <>
      <AddDeviceDialog isOpen={isOpen} tab={tab} onTabChange={setTab} onClose={close} />
      <LinkConfirmPage />
    </>
  );
}
