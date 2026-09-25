import { router } from 'expo-router';

import { ConnectForm } from '@/features/pairing/ConnectForm';
import { Screen } from '@/ui';

export default function AddHostScreen() {
  return (
    <Screen scroll>
      <ConnectForm onPaired={() => router.back()} />
    </Screen>
  );
}
