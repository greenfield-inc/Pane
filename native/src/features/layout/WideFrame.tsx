import { useNavigationContainerRef } from 'expo-router';
import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { ScreenFocus } from '@/daemon';
import { topScreen } from '@/features/app/reopenScreen';
import { ArchiveHoldProvider } from '@/features/approvals/ArchiveUndo';
import { HomeScreen } from '@/features/home/HomeScreen';
import { useTheme } from '@/theme';

import { InColumn, useWideLayout } from './wideLayout';
import { columnWidth } from './windowRule';

/**
 * The signed-in app's frame. In a wide window Home is docked in a column to the left of the stack;
 * otherwise the stack fills the window and its root is Home. The stack keeps its place in the tree
 * either way, so folding, unfolding and collapsing only change widths: nothing open is remounted.
 */
export function WideFrame({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const wide = useWideLayout(state => state.wide);
  const width = useWideLayout(state => state.window.width);
  const setWindow = useWideLayout(state => state.setWindow);
  const setOpen = useWideLayout(state => state.setOpen);
  const navigation = useNavigationContainerRef();
  useEffect(() => {
    const note = () => setOpen(topScreen(navigation.getRootState()));
    note();
    return navigation.addListener('state', note);
  }, [navigation, setOpen]);

  return (
    <ArchiveHoldProvider>
      {/* What is really laid out, not the reported window: React Native can report a stale size on a fold. */}
      <View style={styles.row} onLayout={({ nativeEvent: { layout } }) => setWindow({ width: layout.width, height: layout.height })}>
        {wide ? (
          <View key="home" testID="home-column" style={[styles.column, { width: columnWidth(width), backgroundColor: theme.colors.background, borderRightColor: theme.colors.border }]}>
            <InColumn value>
              {/* The column is always in view, whatever the stack shows. */}
              <ScreenFocus value>
                <HomeScreen />
              </ScreenFocus>
            </InColumn>
          </View>
        ) : null}
        <View key="stack" style={styles.fill}>{children}</View>
      </View>
    </ArchiveHoldProvider>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  column: { borderRightWidth: StyleSheet.hairlineWidth },
  fill: { flex: 1 },
});
