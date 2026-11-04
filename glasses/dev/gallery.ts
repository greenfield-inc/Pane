// Dev only (not in the build): shows the screens the demo can't reach, for simulator screenshots.
// Open http://localhost:<port>/dev/gallery.html in the Even simulator; swipe down for the next one,
// or add ?page=<name> to open on one.
/// <reference types="vite/client" />
import { OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import claudePermission from '../test/fixtures/claude-permission.txt?raw';
import codexApproval from '../test/fixtures/codex-approval.txt?raw';
import { findMenu } from '../src/menu';
import { Display, type Page } from '../src/display';
import { homeListPage, homeRows } from '../src/homeList';
import type { Card, Computer, PaneEntry } from '../src/model';
import { noAnswerMessage } from '../src/host';
import { LOCKED_OUT, ORIGIN_REFUSED, ambientPage, awayPage, bannerPage, connectingPage, infoCardPage, keysRefusedPage, newSessionPage, noComputerPage, pairingFailedPage, pickerPage, refusedPage, terminalFooter, terminalPage, unjoinedPage } from '../src/screens';

const now = Date.now();
const clock = (epochMs: number) => new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const originRefusal = {
  code: ORIGIN_REFUSED,
  message: 'This computer accepts glasses tokens only from the Even app; this request came from https://evenhub.example.',
  next: "Allow it in Pane on that computer: Settings › Remote Access › Glasses.",
};
const paneChat = { kind: 'session' as const, id: 's', name: 'Pane Chat', agent: 'Claude', status: 'working' as const, panelId: 'p' };
/** Four computers, one of each mark, the travel laptop away since 9:12 and old-box on a Pane that reports no OS. */
let minutes = 0;
const pane = (name: string, agent = 'Claude', status: PaneEntry['status'] = 'idle', kind: PaneEntry['kind'] = 'pane'): PaneEntry => {
  minutes += 7;
  return { kind, id: name, name, agent, status, panelId: name, activityAt: now - minutes * 60_000 };
};
const travel: Computer = { id: 'travel', name: 'travel-laptop', status: 'offline', lastSeenAt: new Date(now).setHours(9, 12, 0, 0), os: 'macOS', entries: [pane('trip-notes')] };
const homeComputers: Computer[] = [
  { id: 'studio', name: 'studio-mac', status: 'live', lastSeenAt: now, os: 'macOS', entries: [pane('rate-limit-retries', 'Claude', 'needs you'), pane('Spring sale launch', 'Claude', 'working', 'session'), pane('add-dark-mode'), pane('upgrade-react-19', 'Codex', 'stopped')] },
  { id: 'build', name: 'build-box', status: 'live', lastSeenAt: now, os: 'Linux', entries: [pane('nightly-backup', 'Codex', 'needs you'), pane('terraform-upgrade', 'Codex'), pane('Backup rotation', 'Codex', 'idle', 'session')] },
  { id: 'office', name: 'office-pc', status: 'live', lastSeenAt: now, os: 'Windows', entries: [pane('windows-installer', 'Claude', 'working')] },
  travel,
  { id: 'old', name: 'old-box', status: 'live', lastSeenAt: now, os: null, entries: [pane('legacy-cron', 'shell')] },
];
const question = (computerId: string, machine: string, paneName: string, createdAt: number): Card => ({
  key: `${computerId}:${paneName}`, computerId, machine, itemId: paneName, ui: 'options', waiting: true, title: `${paneName} asks`, choices: ['Yes'], suggestions: [], paneName, paneId: paneName, panelId: paneName, createdAt,
});
const homeCards = [question('build', 'build-box', 'nightly-backup', now - 60_000), question('studio', 'studio-mac', 'rate-limit-retries', now - 120_000)];
const rows = homeRows(homeComputers, homeCards);
const info: Card = {
  key: 'office:installer-built', computerId: 'office', machine: 'office-pc', itemId: 'installer-built', ui: 'info', waiting: false,
  title: 'Installer built and signed.', context: 'Pane-Setup-2.4.211.exe is in dist/. Smoke test passed on Windows 11.',
  choices: [], suggestions: [], paneName: 'windows-installer', paneId: 'windows-installer', panelId: 'windows-installer', createdAt: now - 30_000,
};
const infoRows = homeRows(homeComputers, [...homeCards, info]);
const offlineAt = rows.findIndex((row) => row.computerId === 'travel');
/** Computers that couldn't join, one per reason, after the rows above. */
const unjoined = [
  { name: 'media-pc', reason: 'update Pane there' },
  { name: 'old-laptop', reason: 'revoked here · pair from phone' },
  { name: 'nas', reason: 'needs its password' },
  { name: 'public-box', reason: 'Funnel is on' },
  { name: 'devbox', reason: 'not answering' },
];
const unjoinedRows = homeRows(homeComputers, homeCards, unjoined);
/** The home list as it opens: the new-Session row on studio-mac first, selected. */
const newRows = homeRows(homeComputers, homeCards, [], homeComputers[0]);
const firstUnjoined = unjoinedRows.findIndex((row) => row.kind === 'computer' && row.reason);
const nightly: Card = {
  key: 'b:n', computerId: 'build', machine: 'build-box', itemId: 'n', ui: 'options', waiting: true, choices: ['Restore', 'Skip'], suggestions: [],
  title: "Restore from Tuesday's snapshot, or skip tonight's backup?", paneName: 'nightly-backup', createdAt: now,
};
const darkMode: Card = {
  key: 'a:d', computerId: 'studio', machine: 'studio-mac', itemId: 'd', ui: 'info', waiting: false, choices: [], suggestions: [],
  title: 'PR #212 is ready for review: dark theme tokens and a toggle in Settings.', paneName: 'add-dark-mode', panelId: 'p', createdAt: now,
};
const pages: Array<[string, Page]> = [
  ['ambient-two-asking', ambientPage({ machines: [{ name: 'studio-mac', os: 'macOS' }, { name: 'build-box', os: 'Linux' }], questions: 2, updates: 0 })],
  ['ambient-both', ambientPage({ machines: [{ name: 'studio-mac', os: 'macOS' }, { name: 'build-box', os: 'Linux' }], questions: 2, updates: 1 })],
  ['ambient-nothing-waiting', ambientPage({ machines: [], questions: 0, updates: 0 })],
  ['ambient-unreachable', ambientPage('unreachable')],
  ['banner-question', bannerPage(nightly, 1, 'Linux')],
  ['banner-several', bannerPage(nightly, 3, 'Linux')],
  ['banner-info', bannerPage(darkMode, 1, 'macOS')],
  ['terminal-keys-refused', keysRefusedPage(paneChat, "studio-mac's Pane can't take keys from the glasses yet.", 'Update Pane on studio-mac.')],
  ['terminal-held-at-your-message', terminalPage({
    entry: paneChat, scrolledUp: 0, more: 18, footer: terminalFooter(undefined),
    lines: ['> yes, do the dry run first', '', 'Here is what the dry run found on', 'parsa-4090m-workstation-win11pro.', '', '1. Pane 2.4.200 is installed from the Microsoft Store build, so', 'runpane update hands off to the Store instead of downloading', 'the installer itself.'],
  })],
  ['away-offline', awayPage(travel, clock, 'trip-notes')],
  ['new-session-listening', newSessionPage('studio-mac', 'Find why checkout charges some carts twice')],
  ['new-session-starting', newSessionPage('studio-mac', 'Find why checkout charges some carts twice', true)],
  ...unjoined.map(({ name, reason }): [string, Page] => [`unjoined-${name}`, unjoinedPage(name, reason)]),
  ['error-no-computer-reachable', noComputerPage(3)],
  ['error-no-computer-first-time', noComputerPage(1, noAnswerMessage('studio-mac', location.origin))],
  ['error-pairing-no-answer', pairingFailedPage([`${noAnswerMessage('studio-mac', location.origin)} Then paste again.`])],
  ['error-origin-refused', refusedPage('devbox', originRefusal)],
  ['error-origin-removed', refusedPage('studio-mac', {
    code: ORIGIN_REFUSED,
    message: `studio-mac doesn't allow this app (origin ${location.origin}).`,
    next: 'Allow it in Pane on that computer: Settings › Remote Access › Glasses › Allow.',
  })],
  ['error-locked-out', refusedPage('devbox', {
    code: LOCKED_OUT,
    message: 'This computer refused too many glasses requests from this device, so it is ignoring it for 60 s.',
    next: "Wait 60 s. If you did not cause these, revoke the glasses in Pane's Settings › Remote Access.",
    retryAt: now + 60_000,
  })],
  ['error-token-revoked', refusedPage('devbox', {
    code: 'ERR_GLASSES_TOKEN_INVALID',
    message: 'These glasses are not paired with this computer, or were revoked.',
    next: 'Pair again from the Pane app: Settings › Glasses › Pair glasses.',
  })],
  ['home-connecting', connectingPage(3)],
  ['home-connecting-one-computer', connectingPage(1)],
  ['info-card', infoCardPage(info)],
  // A native list keeps its swipes, so lists come last.
  ...([['picker-claude-permission', claudePermission], ['picker-codex-approval', codexApproval]] as const).map(([name, screen]): [string, Page] => {
    const menu = findMenu(screen.split('\n'));
    return [name, menu ? pickerPage(paneChat, menu.question, menu.choices, false, terminalFooter(undefined)) : connectingPage(0)];
  }),
  ['home-list-new-session', homeListPage(newRows, { selected: 0 }, clock)],
  ['home-list-top', homeListPage(rows, { selected: 0 }, clock)],
  ['home-list-selected', homeListPage(rows, { selected: 3 }, clock)],
  ['home-list-offline', homeListPage(rows, { selected: offlineAt }, clock)],
  ['home-list-last-page', homeListPage(rows, { selected: rows.length - 1 }, clock)],
  ['home-list-after-answer', homeListPage(rows, { selected: 0, confirmation: 'Answered nightly-backup: Yes' }, clock)],
  ['home-list-outline', homeListPage(rows, { selected: 0, marks: 'outline' }, clock)],
  ['home-list-info-row', homeListPage(infoRows, { selected: infoRows.findIndex((row) => row.kind === 'info') }, clock)],
  ['home-list-unjoined', homeListPage(unjoinedRows, { selected: firstUnjoined }, clock)],
];

async function main(): Promise<void> {
  const bridge = await waitForEvenAppBridge();
  const display = new Display(bridge);
  // ?page=<name> opens on that page; a list keeps the swipes that would leave it.
  let index = Math.max(0, pages.findIndex(([name]) => name === new URLSearchParams(location.search).get('page')));
  const show = () => {
    const [name, page] = pages[index] ?? pages[0];
    console.info(`[gallery] ${index + 1}/${pages.length} ${name}`);
    void display.show(page);
  };
  bridge.onEvenHubEvent((event) => {
    const type = event.sysEvent?.eventType ?? event.textEvent?.eventType ?? event.listEvent?.eventType;
    if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) index = Math.min(pages.length - 1, index + 1);
    else if (type === OsEventTypeList.SCROLL_TOP_EVENT) index = Math.max(0, index - 1);
    else return;
    show();
  });
  show();
}

void main();
