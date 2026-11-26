import { openedOnPhoneFiles } from '@/daemon/savedStateFiles';
import { DEMO_PROFILE } from '@/features/demo/demoHost';

import { createOpenedOnPhone } from './openedOnPhone';

/** When this phone last opened each Pane, by machine. The demo's are never saved. */
export const useOpenedOnPhone = createOpenedOnPhone(openedOnPhoneFiles, { saves: id => id !== DEMO_PROFILE.id });
