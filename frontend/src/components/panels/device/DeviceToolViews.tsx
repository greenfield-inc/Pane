import { usePausableDismiss } from '../../../hooks/usePausableDismiss';
import { Copy, Download, MessageSquareText, Pencil, ShipWheel, X } from 'lucide-react';
import type { DeviceDriver } from '../../../../../shared/types/devices';
import { cn } from '../../../utils/cn';
import type { CaptureNotice } from './deviceTools';

const NOTICE_MS = 8_000;

export function CaptureCard({ notice, onCopy, onSave, onMarkUp, onClose }: { notice: CaptureNotice; onCopy: () => void; onSave: () => void; onMarkUp: () => void; onClose: () => void }) {
  // Closes itself after a while, paused while hovered or focused.
  const dismiss = usePausableDismiss(onClose, NOTICE_MS);
  const action = 'flex items-center gap-1 rounded border border-border-primary px-2 py-0.5 text-xs text-text-primary hover:bg-surface-hover';
  return (
    <div
      className="absolute bottom-14 right-4 z-20 flex items-center gap-3 rounded-lg border border-border-primary bg-surface-primary p-2 pr-3 shadow-lg"
      data-testid="device-capture-card"
      {...dismiss}
    >
      <img src={notice.capture.dataUrl} alt="" className="h-14 w-auto max-w-[56px] rounded border border-border-primary object-contain" />
      <div className="flex flex-col gap-1.5">
        <p className="flex items-center gap-1.5 text-xs font-medium text-text-primary"><MessageSquareText className="h-3.5 w-3.5 text-status-success" />{notice.title}</p>
        <div className="flex gap-1.5">
          <button type="button" className={action} onClick={onCopy}><Copy className="h-3 w-3" />Copy</button>
          <button type="button" className={action} onClick={onSave}><Download className="h-3 w-3" />Save</button>
          <button type="button" className={action} onClick={onMarkUp}><Pencil className="h-3 w-3" />Mark up</button>
        </div>
      </div>
      <button type="button" aria-label="Close" className="self-start text-text-tertiary hover:text-text-primary" onClick={onClose}><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}

/**
 * Who is driving, beside the caption: the agent while its device tool runs, with Take over; or
 * the person after Take over, with Hand to agent and whether an agent waits for the device.
 */
export function DriverChip({ driver, agentName, onTakeOver, onHandBack }: { driver: DeviceDriver | undefined; agentName?: string; onTakeOver: () => void; onHandBack: () => void }) {
  if (!driver) return null;
  const person = driver.by === 'person';
  const label = person ? (driver.agentWaiting ? `You're driving · ${driver.agentWaiting} is waiting` : "You're driving") : `${driver.agent} is driving`;
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-2 rounded-full border px-2.5 py-0.5', person ? 'border-border-primary text-text-primary' : 'border-interactive text-text-primary')}
      data-testid="device-driver"
    >
      <ShipWheel className="h-3.5 w-3.5" />
      <span className="truncate">{label}</span>
      <button type="button" className="text-interactive hover:text-interactive-hover" onClick={person ? onHandBack : onTakeOver}>
        {person ? `Hand to ${driver.agentWaiting ?? agentName ?? 'agent'}` : 'Take over'}
      </button>
    </span>
  );
}
