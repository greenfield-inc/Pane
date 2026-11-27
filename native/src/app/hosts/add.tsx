import { router } from 'expo-router';

import { ConnectForm } from '@/features/pairing/ConnectForm';
import { Screen } from '@/ui';
import { FocusScope } from '@/features/controller/FocusScope';

function AddHostScreen() {
  return (
    <Screen scroll>
      <ConnectForm onPaired={() => router.back()} />
    </Screen>
  );
}

/** A controller stays inside this screen while it is open; B closes it. */
export default function AddHostScreenRoute() {
  return <FocusScope onBack={() => router.back()}><AddHostScreen /></FocusScope>;
}
