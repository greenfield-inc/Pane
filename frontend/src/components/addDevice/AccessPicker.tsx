import { DEVICE_ACCESS_LABELS, READ_ONLY_GRANT_HELP, READ_ONLY_GRANT_WARNING } from '../../../../shared/types/accessLevel';
import { SegmentedControl } from '../settings/SettingsControls';
import { useAddDeviceStore } from './addDeviceStore';

const OPTIONS = [
  { id: 'full', label: DEVICE_ACCESS_LABELS.full },
  { id: 'read', label: DEVICE_ACCESS_LABELS.read },
] as const;

/** What the code or link gives whoever uses it, with what Read only means while it is chosen. */
export function AccessPicker() {
  const access = useAddDeviceStore((state) => state.access);
  const setAccess = useAddDeviceStore((state) => state.setAccess);
  return (
    <div className="space-y-2">
      <SegmentedControl label="Access" value={access} options={OPTIONS} onChange={setAccess} />
      {access === 'read' && (
        <div className="space-y-1 text-xs" role="status">
          <p className="text-text-secondary">{READ_ONLY_GRANT_HELP}</p>
          <p className="text-status-warning">{READ_ONLY_GRANT_WARNING}</p>
        </div>
      )}
    </div>
  );
}
