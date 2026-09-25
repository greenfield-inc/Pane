import { router } from 'expo-router';
import { useState } from 'react';

import { takePendingPairingCode } from '@/features/pairing/deepLink';
import { ConnectForm } from '@/features/pairing/ConnectForm';
import { Screen } from '@/ui';

/** Opened by a pane-remote:// link, signed in or not. The person confirms before connecting. */
export default function PairFromLinkScreen() {
  const [code] = useState(() => takePendingPairingCode() ?? '');
  return (
    <Screen scroll>
      <ConnectForm initialCode={code} onPaired={() => router.back()} />
    </Screen>
  );
}
