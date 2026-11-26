import type { ProfileSyncComputer, ProfileSyncStatus } from '../../../../shared/types/profileSync';

function changes(count: number): string {
  return `${count} change${count === 1 ? '' : 's'}`;
}

function names(computers: ProfileSyncComputer[]): string {
  return computers.map(computer => computer.name).join(', ');
}

/** The Profiles footer's sync line: who has every save, and what an offline computer gets when it reconnects. */
export function syncFooterText(status: ProfileSyncStatus | null): string {
  if (!status) return '';
  if (!status.computers.length) return 'No other computers to sync with';
  if (status.running && !status.lastSyncAt) return 'Syncing with your other computers…';
  const parts: string[] = [];
  const synced = status.computers.filter(computer => computer.state === 'up-to-date');
  if (synced.length) parts.push(`Synced to ${names(synced)}`);
  for (const computer of status.computers) {
    if (computer.state === 'offline') parts.push(computer.waiting.length ? `${computer.name} gets ${changes(computer.waiting.length)} when it reconnects` : `${computer.name} is offline`);
    else if (computer.state === 'failed') parts.push(`${computer.name} didn't get ${changes(computer.waiting.length)}`);
    else if (computer.state === 'outdated') parts.push(`${computer.name} needs a newer Pane`);
    else if (computer.state === 'off') parts.push(`${computer.name} has Profiles off`);
  }
  if (status.running) parts.push('syncing…');
  return parts.join(' · ');
}

/** One computer's state in the Sync sheet. */
export function syncStateText(computer: ProfileSyncComputer): string {
  switch (computer.state) {
    case 'up-to-date':
      return 'Up to date (every save is pushed)';
    case 'offline':
      return computer.waiting.length ? `Offline: gets ${changes(computer.waiting.length)} when it reconnects` : 'Offline: gets any changes when it reconnects';
    case 'failed':
      return computer.error ?? `Didn't get ${changes(computer.waiting.length)}; the next sync tries again`;
    case 'outdated':
      return computer.error ?? 'Needs a newer Pane to sync profiles';
    case 'off':
      return 'Profiles is off there: turn it on in its Settings to sync';
  }
}

/** What a save sends where, for its notice: the save itself syncs in the background. */
export function savedSyncText(status: ProfileSyncStatus | null): string {
  const computers = status?.computers ?? [];
  const sending = computers.filter(computer => computer.state !== 'offline' && computer.state !== 'outdated' && computer.state !== 'off');
  const later = computers.filter(computer => computer.state === 'offline');
  const parts: string[] = [];
  if (sending.length) parts.push(`Sending it to ${names(sending)}`);
  if (later.length) parts.push(`${names(later)} ${later.length === 1 ? 'gets' : 'get'} it when ${later.length === 1 ? 'it reconnects' : 'they reconnect'}`);
  return parts.length ? ` ${parts.join('; ')}.` : '';
}

/** The notice after Sync now. */
export function syncNowText(status: ProfileSyncStatus): string {
  if (!status.computers.length) return 'There are no other computers to sync with.';
  const sent = status.computers.filter(computer => computer.state === 'up-to-date');
  const later = status.computers.filter(computer => computer.state === 'offline');
  const failed = status.computers.filter(computer => computer.state === 'failed' || computer.state === 'outdated' || computer.state === 'off');
  const parts: string[] = [];
  if (sent.length) parts.push(`Sent all profiles to ${names(sent)}`);
  if (later.length) parts.push(`${names(later)} ${later.length === 1 ? 'gets' : 'get'} them when ${later.length === 1 ? 'it reconnects' : 'they reconnect'}`);
  for (const computer of failed) parts.push(`${computer.name}: ${syncStateText(computer)}`);
  return `${parts.join('; ')}.`;
}
