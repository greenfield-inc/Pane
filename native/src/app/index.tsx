import { useIsFocused } from 'expo-router';

import { ScreenFocus } from '@/daemon';
import { HomeScreen } from '@/features/home/HomeScreen';

/** Home stays mounted under every screen it opens; its lists read again when it comes back into view. */
export default function Home() {
  return (
    <ScreenFocus value={useIsFocused()}>
      <HomeScreen />
    </ScreenFocus>
  );
}
