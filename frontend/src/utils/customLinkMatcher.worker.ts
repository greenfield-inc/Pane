import { findCustomLinks } from '../../../shared/utils/customLinks';
import type { CustomLinkMatchRequest, CustomLinkWorkerReady } from './customLinkMatcher';

// Runs the person's own patterns here, off the window's thread, so one that backtracks forever can be stopped.
addEventListener('message', (event: MessageEvent<CustomLinkMatchRequest>) => {
  const { id, text, links } = event.data;
  postMessage({ id, matches: findCustomLinks(text, links) });
});

// Tells the window this code has loaded, so it starts timing a line only from here.
postMessage({ ready: true } satisfies CustomLinkWorkerReady);
