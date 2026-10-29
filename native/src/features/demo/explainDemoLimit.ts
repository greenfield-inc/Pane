import { Alert } from 'react-native';

import { NEEDS_COMPUTER } from './demoWorkspace';

/** Said instead of opening a picker, a permission prompt or key setup the demo can't use. */
export function explainDemoLimit(feature: 'Sending files' | 'Voice'): void {
  Alert.alert(`${feature} needs your computer`, `${feature} ${NEEDS_COMPUTER}`);
}
