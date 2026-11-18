import { Bone, LoadingStatus, Skeleton } from '../ui/Skeleton';
import { PHONE_SIDES } from './phone/phoneParts';

/** Title, chips, description and a few thread items: the column a to-do opens into. */
const CHIP_WIDTHS = [88, 64, 112, 72];
const DESCRIPTION_LINES = [92, 86, 58];
const THREAD_ITEMS = [{ lines: [70, 44] }, { lines: [82, 66, 30] }];

/**
 * A to-do's page while its detail loads (#1509): bones where the title, its chips, the card, the
 * thread and the composer land, in the page's own column. The header above it is the real one.
 */
export function TodoPageSkeleton({ number }: { number: number }) {
  return (
    <>
      <LoadingStatus label={`Opening T-${number}`} />
      <Skeleton className="flex min-h-0 flex-1 flex-col" testId="todo-page-skeleton">
        <div className="min-h-0 flex-1 px-7 pb-3 pt-5">
          <div className="mx-auto max-w-[760px]">
            <div className="mb-2 mt-1 flex h-[27px] items-center"><Bone className="h-[15px] w-[46%]" /></div>
            <ChipBones />
            <DescriptionBones />
            <ThreadBones />
          </div>
        </div>
        <div className="shrink-0 px-7 pb-3.5 pt-2.5">
          <div className="mx-auto h-[76px] max-w-[760px] rounded-[10px] border border-border-primary bg-surface-secondary" />
        </div>
      </Skeleton>
    </>
  );
}

/** The same column on a phone: title, wrapping chips, the card and the thread, then the composer. */
export function PhoneTodoPageSkeleton({ number }: { number: number }) {
  return (
    <>
      <LoadingStatus label={`Opening T-${number}`} />
      <Skeleton className="flex min-h-0 flex-1 flex-col" testId="phone-todo-page-skeleton">
        <div className={`${PHONE_SIDES} min-h-0 flex-1 pb-[18px] pt-3.5`}>
          <div className="mb-2.5 flex h-[26px] items-center"><Bone className="h-[15px] w-[70%]" /></div>
          <ChipBones />
          <DescriptionBones />
          <ThreadBones />
        </div>
        <div className="shrink-0 border-t border-border-primary px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
          <div className="h-11 rounded-[10px] border border-border-primary bg-surface-secondary" />
        </div>
      </Skeleton>
    </>
  );
}

function ChipBones() {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {CHIP_WIDTHS.map(width => <Bone key={width} className="h-6 rounded-full" style={{ width }} />)}
    </div>
  );
}

function DescriptionBones() {
  return (
    <div className="mb-2 mt-3.5 flex flex-col">
      {DESCRIPTION_LINES.map(width => (
        <div key={width} className="flex h-[21px] items-center"><Bone className="h-2.5" style={{ width: `${width}%` }} /></div>
      ))}
    </div>
  );
}

function ThreadBones() {
  return (
    <div className="mt-5 flex flex-col gap-4">
      {THREAD_ITEMS.map(item => (
        <div key={item.lines.join('-')} className="flex gap-2.5">
          <Bone className="h-6 w-6 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-5 items-center"><Bone className="h-2.5 w-28" /></div>
            {item.lines.map(width => (
              <div key={width} className="flex h-[21px] items-center"><Bone className="h-2.5" style={{ width: `${width}%` }} /></div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const FILE_LINES = [88, 94, 72, 0, 90, 84, 60, 0, 92, 48];

/** A file on a phone while it is read: lines of text where the document lands. */
export function PhoneFileSkeleton({ label }: { label: string }) {
  return (
    <>
      <LoadingStatus label={`Opening ${label}`} />
      <Skeleton className="min-h-0 flex-1 px-4 py-3" testId="phone-file-skeleton">
        {FILE_LINES.map((width, index) => (
          <div key={index} className="flex h-[21px] items-center">{width > 0 && <Bone className="h-2.5" style={{ width: `${width}%` }} />}</div>
        ))}
      </Skeleton>
    </>
  );
}

const PHONE_ROWS = [{ title: 68, meta: 44 }, { title: 82, meta: 36 }, { title: 54, meta: 50 }, { title: 74, meta: 30 }];

/** The phone list while the to-dos load: a group header and two-line rows. */
export function PhoneTodoListSkeleton() {
  return (
    <>
      <LoadingStatus label="Loading to-dos" />
      <Skeleton testId="phone-todos-skeleton">
        <div className="flex h-[34px] items-center gap-2 border-b border-border-secondary bg-surface-secondary pl-[max(1rem,env(safe-area-inset-left))] pr-4">
          <Bone className="h-3.5 w-3.5 rounded-full" />
          <Bone className="h-2.5 w-24" />
        </div>
        {PHONE_ROWS.map(row => (
          <div key={row.title} className="flex items-start gap-2.5 border-b border-border-secondary py-[11px] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
            <Bone className="mt-[3px] h-3.5 w-3.5 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <div className="flex h-[20.6px] items-center"><Bone className="h-3" style={{ width: `${row.title}%` }} /></div>
              <div className="mt-px flex h-[17px] items-center"><Bone className="h-2" style={{ width: `${row.meta}%` }} /></div>
            </div>
          </div>
        ))}
      </Skeleton>
    </>
  );
}
