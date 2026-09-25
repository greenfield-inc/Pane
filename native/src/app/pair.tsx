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
        // A cold-start link opens this screen with nothing under it.
        onPaired={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
    </Screen>
  );
}
