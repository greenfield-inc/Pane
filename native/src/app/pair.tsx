import { router, useLocalSearchParams } from 'expo-router';

import { ConnectForm } from '@/features/pairing/ConnectForm';
import { Screen } from '@/ui';

/** Opened by a pane-remote:// link, signed in or not. The person confirms before connecting. */
export default function PairFromLinkScreen() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  return (
    <Screen scroll>
      <ConnectForm initialCode={code} onPaired={() => router.back()} />
    </Screen>
  );
}
