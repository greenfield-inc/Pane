import type { Place, PlaceMachine } from '../components/WhereItRuns';

/** The Pane Cloud docs page, which says which work needs a Mac and how to run that Session on one (D-85). */
export const MAC_WORK_DOCS_URL = 'https://runpane.com/docs/pane-cloud';

/** Where it runs, arranged for the repo. */
export interface MacWorkPlaces {
  others: PlaceMachine[];
  /** The place to select, or null to keep the usual default. */
  preferred: Place | null;
  /** One of the person's Macs is online to run it on. */
  macAvailable: boolean;
}

const isMac = (machine: PlaceMachine) => machine.os === 'macOS';

/**
 * Where it runs, for a repo with an Xcode project: Pane Cloud VMs run Linux, so iOS Simulator and
 * Xcode work needs one of the person's Macs (D-85). Their Macs come first and one is picked before
 * they create the Session: This Mac when the window is on one, else the first other Mac. A repo
 * without one keeps the usual order and default.
 */
export function placesForMacWork({ current, others, xcode }: { current: PlaceMachine; others: readonly PlaceMachine[]; xcode: boolean }): MacWorkPlaces {
  const macs = others.filter(isMac);
  const macAvailable = isMac(current) || macs.length > 0;
  if (!xcode) return { others: [...others], preferred: null, macAvailable };
  const ordered = [...macs, ...others.filter((machine) => !isMac(machine))];
  if (isMac(current)) return { others: ordered, preferred: 'here', macAvailable };
  return { others: ordered, preferred: macs[0]?.id ?? null, macAvailable };
}
