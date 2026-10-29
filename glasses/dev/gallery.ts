// Dev only (not in the build): shows the screens the demo can't reach, for simulator screenshots.
// Open http://localhost:<port>/dev/gallery.html in the Even simulator; swipe down for the next one.
/// <reference types="vite/client" />
import { OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import claudePermission from '../test/fixtures/claude-permission.txt?raw';
import codexApproval from '../test/fixtures/codex-approval.txt?raw';
import { findMenu } from '../src/menu';
import { Display, type Page } from '../src/display';
import type { Computer } from '../src/model';
import { noAnswerMessage } from '../src/host';
import { LOCKED_OUT, ORIGIN_REFUSED, allClearPage, computersPage, connectingPage, keysRefusedPage, noComputerPage, pairingFailedPage, pickerPage, refusedPage, terminalFooter, terminalPage } from '../src/screens';

const now = Date.now();
const clock = (epochMs: number) => new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const originRefusal = {
  code: ORIGIN_REFUSED,
  message: 'This computer accepts glasses tokens only from the Even app; this request came from https://evenhub.example.',
  next: "Allow it in Pane on that computer: Settings › Remote Access › Glasses.",
};
const computers: Computer[] = [
  { id: 'a', name: 'studio-mac', status: 'live', lastSeenAt: now, paneCount: 5, workingCount: 1 },
  { id: 'b', name: 'devbox', status: 'refused', lastSeenAt: now, paneCount: 0, workingCount: 0, refusal: originRefusal },
  { id: 'c', name: 'laptop', status: 'offline', lastSeenAt: now - 3_600_000, paneCount: 0, workingCount: 0 },
];
const paneChat = { kind: 'session' as const, id: 's', name: 'Pane Chat', agent: 'Claude', status: 'working' as const, panelId: 'p' };
const pages: Array<[string, Page]> = [
  ['terminal-keys-refused', keysRefusedPage(paneChat, "studio-mac's Pane can't take keys from the glasses yet.", 'Update Pane on studio-mac.')],
  ['terminal-held-at-your-message', terminalPage({
    entry: paneChat, scrolledUp: 0, more: 18, footer: terminalFooter(undefined),
    lines: ['> yes, do the dry run first', '', 'Here is what the dry run found on', 'parsa-4090m-workstation-win11pro.', '', '1. Pane 2.4.200 is installed from the Microsoft Store build, so', 'runpane update hands off to the Store instead of downloading', 'the installer itself.'],
  })],
  ['home-all-clear', allClearPage(3)],
  ['home-all-clear-after-answer', allClearPage(3, 'Answered fix-login: Loosen retry')],
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
  // A native list keeps its swipes, so lists come last.
  ...([['picker-claude-permission', claudePermission], ['picker-codex-approval', codexApproval]] as const).map(([name, screen]): [string, Page] => {
    const menu = findMenu(screen.split('\n'));
    return [name, menu ? pickerPage(paneChat, menu.question, menu.choices, false, terminalFooter(undefined)) : allClearPage(0)];
  }),
  ['computers-refused-and-offline', computersPage(computers, clock)],
];

async function main(): Promise<void> {
  const bridge = await waitForEvenAppBridge();
  const display = new Display(bridge);
  let index = 0;
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
