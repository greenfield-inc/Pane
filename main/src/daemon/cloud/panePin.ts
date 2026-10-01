/**
 * The Pane version a Runpane Cloud Session may be upgraded to on wake. The laptop CLI writes the pin into
 * the Session as a root-owned file (`new`, `wake`, `repair`, `coordinator deploy --pin-*`; rp-bootstrap.sh
 * `pin-pane`); the daemon's `runpane:cloud:upgrade` installs only a request equal to it. The coordinator
 * relays the pin but cannot choose it, so its token can't install an arbitrary package as root.
 */
export const CLOUD_PANE_PIN_FILE = '/etc/rp-cloud/pane-pin.json';

/**
 * The oldest Pane that enforces `scope: 'coordinator'` client records. An older daemon ignores the scope,
 * so its coordinator token would be a full-access client: never pin below this. Fork builds are versioned
 * `<package version>-rc.<commit UTC time>.g<sha8>`; in Debian order every release after 2.4.141 is newer.
 */
export const MIN_CLOUD_PIN_PANE_VERSION = '2.4.141-rc.20260930080320';

export interface CloudPanePin {
  version: string;
  url: string;
  sha256: string;
}

export function isPinnablePaneVersion(version: string): boolean {
  return compareDebianVersions(version, MIN_CLOUD_PIN_PANE_VERSION) >= 0;
}

/** dpkg's version order (`dpkg --compare-versions`): negative, zero or positive, like a sort comparator. */
export function compareDebianVersions(left: string, right: string): number {
  const a = splitDebianVersion(left);
  const b = splitDebianVersion(right);
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  return compareFragment(a.upstream, b.upstream) || compareFragment(a.revision, b.revision);
}

function splitDebianVersion(version: string): { epoch: number; upstream: string; revision: string } {
  const colon = version.indexOf(':');
  const epoch = colon > 0 ? Number(version.slice(0, colon)) || 0 : 0;
  const rest = colon > 0 ? version.slice(colon + 1) : version;
  const dash = rest.lastIndexOf('-');
  return dash >= 0
    ? { epoch, upstream: rest.slice(0, dash), revision: rest.slice(dash + 1) }
    : { epoch, upstream: rest, revision: '' };
}

const isDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9';

/** A character's weight in dpkg's non-digit runs: `~` sorts before the end, letters before other symbols. */
function charOrder(char: string | undefined): number {
  if (char === undefined || isDigit(char)) return 0;
  if (/[A-Za-z]/u.test(char)) return char.charCodeAt(0);
  if (char === '~') return -1;
  return char.charCodeAt(0) + 256;
}

function compareFragment(left: string, right: string): number {
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    while ((i < left.length && !isDigit(left[i])) || (j < right.length && !isDigit(right[j]))) {
      const difference = charOrder(left[i]) - charOrder(right[j]);
      if (difference !== 0) return difference;
      i += 1;
      j += 1;
    }
    while (left[i] === '0') i += 1;
    while (right[j] === '0') j += 1;
    let firstDifference = 0;
    while (isDigit(left[i]) && isDigit(right[j])) {
      if (firstDifference === 0) firstDifference = left.charCodeAt(i) - right.charCodeAt(j);
      i += 1;
      j += 1;
    }
    if (isDigit(left[i])) return 1;
    if (isDigit(right[j])) return -1;
    if (firstDifference !== 0) return firstDifference;
  }
  return 0;
}
