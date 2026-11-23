import type { PaneError } from '../../../../shared/paneError';

/** Whether the agent refused because it is not signed in on this machine (runtime.ts's chatFailure makes these). */
export function isAuthRequired(error: PaneError): boolean { return error.code === 'CHAT_NOT_SIGNED_IN'; }
