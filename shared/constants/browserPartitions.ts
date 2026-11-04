/**
 * The one persistent store every ordinary browser tab uses, in every project and
 * Session, so a login made in one tab holds in all of them and across restarts.
 * Sign-in popups opened from a tab share their opener's store.
 */
export const SHARED_BROWSER_PARTITION = 'persist:pane-browser';

/** The docs viewer's own persistent store. */
export const DOCS_BROWSER_PARTITION = 'persist:pane-docs';
