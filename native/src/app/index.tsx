import { useIsFocused } from 'expo-router';

import { ScreenFocus } from '@/daemon';
import { HomeScreen } from '@/features/home/HomeScreen';
import { NothingOpen } from '@/features/layout/NothingOpen';
import { useWideLayout } from '@/features/layout/wideLayout';

/**
 * The stack's root. On a phone it is Home, mounted under every screen it opens, whose lists read
 * again when it comes back into view. In a wide window Home is the docked column and this says
 * nothing is open.
 */
export default function Home() {
  const focused = useIsFocused();
  const wide = useWideLayout(state => state.wide);
  if (wide) return <NothingOpen />;
  return (
    <ScreenFocus value={focused}>
      <HomeScreen />
    </ScreenFocus>
  );
}
