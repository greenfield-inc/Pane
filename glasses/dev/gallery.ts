// Dev only (not in the build): shows the screens the demo can't reach, for simulator screenshots.
// Open http://localhost:<port>/dev/gallery.html in the Even simulator; swipe down for the next one.
import { OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { Display, type Page } from '../src/display';
import type { Computer } from '../src/model';
import { LOCKED_OUT, ORIGIN_REFUSED, allClearPage, computersPage, loadingPage, noComputerPage, refusedPage } from '../src/screens';

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
const pages: Array<[string, Page]> = [
  ['home-all-clear', allClearPage(3)],
  ['home-all-clear-after-answer', allClearPage(3, 'Answered fix-login: Loosen retry')],
  ['error-no-computer-reachable', noComputerPage(3)],
  ['error-origin-refused', refusedPage('devbox', originRefusal)],
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
  ['home-connecting', loadingPage('Pane · 3 computers', 'Connecting to your computers…')],
  // A native list keeps its swipes, so it comes last.
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
