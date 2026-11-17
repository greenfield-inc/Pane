import { useEffect, useState } from 'react';
import { AddDeviceDialog } from './addDevice/AddDeviceDialog';
import type { AddDeviceTab } from './addDevice/addDeviceStore';

/** Add a device, opened on its Phone tab, for callers that still own their own open state. */
export function PairPhoneDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<AddDeviceTab>('phone');
  useEffect(() => {
    if (isOpen) setTab('phone');
  }, [isOpen]);
  return <AddDeviceDialog isOpen={isOpen} tab={tab} onTabChange={setTab} onClose={onClose} />;
}
