import { create } from 'zustand';

/**
 * Whether the window's link to the machine it shows is up (App sets it from the connection state:
 * this computer, or a host that says connected). A chat's pending handed-over Enter waits for it, so
 * it isn't sent into a link main still refuses writes on (T-132, QA 1781 F-1).
 *
 * `hostResets` counts the window's host resets: each time a resync for a new host is about to clear
 * the outgoing host's Sessions, tiles and cached views (useIPCEvents). Main sends one again when a
 * restore did not complete, so one can come just after an engage landed in a chat, which it then
 * tears down while the person types there (build 12).
 */
export const useWindowLink = create<{ up: boolean; hostResets: number }>(() => ({ up: true, hostResets: 0 }));

/** The window's host state is about to be reset for a new host: what is on screen now goes. */
export function noteWindowHostReset(): void {
  useWindowLink.setState(state => ({ hostResets: state.hostResets + 1 }));
}
