import { Bone, LoadingStatus, Skeleton } from '../../ui/Skeleton';
import { cn } from '../../../utils/cn';

/** Icons on the home screen above the dock; the screen's shape decides how many columns they wrap into. */
const HOME_ICONS = 24;
const DOCK_ICONS = 4;

/**
 * The phone's screen while it boots, connects or waits for its first frame: a home screen in
 * bones on the device's black screen, sized in units of the screen's short side, so it fits a
 * phone, an iPad or a turned device alike.
 */
export function DeviceScreenSkeleton({ chain, label, fading }: {
  /** Skeleton's `chain`: the hold that times this skeleton. */
  chain: string;
  /** What the screen is waiting for, for screen readers. */
  label: string;
  /** The first frame is painted underneath: fade out over it. */
  fading: boolean;
}) {
  return (
    <>
    {/* Beside the skeleton: its root is aria-hidden. */}
    {!fading && <LoadingStatus label={label} />}
    <Skeleton testId="device-screen-skeleton" chain={chain}
      className={cn('absolute inset-0 bg-device-screen [container-type:size]', fading && 'skeleton-fade-out')}>
      <div className="flex justify-between px-[7cqmin] pt-[4.5cqmin]">
        <Bone className="h-[3.5cqmin] w-[11cqmin] rounded-full bg-device-bone" />
        <Bone className="h-[3.5cqmin] w-[15cqmin] rounded-full bg-device-bone" />
      </div>
      <div className="grid justify-center gap-[6cqmin] px-[6cqmin] pt-[9cqmin] [grid-template-columns:repeat(auto-fill,15cqmin)]">
        {Array.from({ length: HOME_ICONS }, (_, index) => <Bone key={index} className="h-[15cqmin] w-[15cqmin] rounded-[3.5cqmin] bg-device-bone" />)}
      </div>
      <div className="absolute inset-x-0 bottom-[5cqmin] flex justify-center gap-[6cqmin]">
        {Array.from({ length: DOCK_ICONS }, (_, index) => <Bone key={index} className="h-[15cqmin] w-[15cqmin] rounded-[3.5cqmin] bg-device-bone" />)}
      </div>
    </Skeleton>
    </>
  );
}
