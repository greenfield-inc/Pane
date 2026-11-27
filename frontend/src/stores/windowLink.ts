import { create } from 'zustand';

/**
 * Whether the window's link to the machine it shows is up (App sets it from the connection state:
 * this computer, or a host that says connected). A chat's pending handed-over Enter waits for it, so
 * it isn't sent into a link main still refuses writes on (T-132, QA 1781 F-1).
 */
export const useWindowLink = create<{ up: boolean }>(() => ({ up: true }));
