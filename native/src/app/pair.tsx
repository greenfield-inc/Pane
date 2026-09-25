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
      <ConnectForm
        initialCode={code}
        // Pairing switches hosts, which remounts the navigator; leave for the
        // app root first so this screen isn't left behind with an empty code.
        onPaired={() => router.replace('/')}
      />
    </Screen>
  );
}
