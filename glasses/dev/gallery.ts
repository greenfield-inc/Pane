// Dev only (not in the build): shows the screens the demo can't reach, for simulator screenshots.
// Open http://localhost:<port>/dev/gallery.html in the Even simulator; swipe down for the next one,
// or add ?page=<name> to open on one.
/// <reference types="vite/client" />
import { OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { Display } from '../src/display';
import { galleryPages } from './galleryPages';

const pages = galleryPages(location.origin);

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
