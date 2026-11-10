import type { MachineMarkOverride, MachineMarkOverrides } from '../../../../shared/utils/machineMarks';

export type MarkChange = (current: MachineMarkOverride) => MachineMarkOverride;

/** The marks map with one machine's override changed; an empty override goes back to automatic. */
export function applyMarkChange(marks: MachineMarkOverrides | undefined, key: string, change: MarkChange): MachineMarkOverrides {
  const next = { ...marks };
  const override = change(next[key] ?? {});
  if (override.letters || override.color) next[key] = override;
  else delete next[key];
  return next;
}

/**
 * Saves mark changes one at a time: each reads the marks only after the previous write has
 * settled, so a quick letters edit and a colour pick both land instead of the later write
 * replacing the earlier one from a stale copy of the map.
 */
export function createMarkSaver({ read, write }: {
  read: () => MachineMarkOverrides | undefined;
  write: (marks: MachineMarkOverrides) => Promise<void>;
}): (key: string, change: MarkChange) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (key, change) => {
    const run = tail.then(() => write(applyMarkChange(read(), key, change)));
    // A failed save is reported by its caller; the next one still runs.
    tail = run.catch(() => undefined);
    return run;
  };
}
