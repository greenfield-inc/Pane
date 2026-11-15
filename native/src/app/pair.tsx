import { router } from 'expo-router';
import { useState } from 'react';

import { parseRelayPairingLink } from '@shared/remoteClient';

import { takePendingPairingCode } from '@/features/pairing/deepLink';
import { ConnectForm } from '@/features/pairing/ConnectForm';
import { RelayPairPrompt } from '@/features/pairing/RelayPairPrompt';
import { Screen } from '@/ui';

/** Opened by a pairing link, signed in or not. The person confirms before connecting. */
export default function PairFromLinkScreen() {
  const [code] = useState(() => takePendingPairingCode() ?? '');
  const link = parseRelayPairingLink(code);
  // Pairing switches hosts, which remounts the navigator; leave for the
  // app root first so this screen isn't left behind with an empty code.
  const onPaired = () => router.replace('/');
  return (
    <Screen scroll>
      {link ? <RelayPairPrompt code={code} link={link} onPaired={onPaired} /> : <ConnectForm initialCode={code} onPaired={onPaired} />}
    </Screen>
  );
}
