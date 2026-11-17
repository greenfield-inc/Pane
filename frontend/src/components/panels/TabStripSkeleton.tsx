import { Bone, Skeleton, TextBone } from '../ui/Skeleton';

/**
 * A tab strip row while its tabs load, with PanelTabStrip's tab geometry: a
 * status dot, the tab's icon and its title, then the "+" button when it has one.
 */
export function TabStripSkeleton({ titles, addButton = true }: {
  /** The titles the tabs will show, which size their bones. */
  titles: readonly string[];
  addButton?: boolean;
}) {
  return (
    <Skeleton className="flex min-h-9 flex-shrink-0 items-center border-b border-border-primary bg-bg-chrome px-2">
      {titles.map((title, index) => (
        <div key={index} className="inline-flex h-[38px] min-w-[8rem] items-center gap-2 px-3 text-sm leading-none">
          <span className="inline-flex h-3 w-3 items-center justify-center"><Bone className="h-2 w-2 rounded-full" /></span>
          <Bone className="h-4 w-4" />
          <TextBone text={title} />
        </div>
      ))}
      {addButton && <span className="inline-flex h-7 w-7 items-center justify-center"><Bone className="h-4 w-4" /></span>}
    </Skeleton>
  );
}
