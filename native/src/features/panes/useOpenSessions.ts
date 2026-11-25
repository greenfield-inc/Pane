import { openSessionFiles } from '@/daemon/savedStateFiles';
import { DEMO_PROFILE } from '@/features/demo/demoHost';

import { createOpenSessions } from './openSessions';

/** Which Sessions the person opened on each machine, on Home and on the Sessions screen. The demo's are never saved. */
export const useOpenSessions = createOpenSessions(openSessionFiles, { saves: id => id !== DEMO_PROFILE.id });
