import { useNavigationContainerRef } from 'expo-router';
import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenFocus } from '@/daemon';
import { closedAny } from '@/features/app/reopenScreen';
import { ArchiveHoldProvider } from '@/features/approvals/ArchiveUndo';
import { HomeScreen } from '@/features/home/HomeScreen';
import { useTheme } from '@/theme';

import { ColumnHandle } from './ColumnHandle';
import { InColumn, noteScreenClosed, useRail, useWideLayout } from './wideLayout';
import { columnRange, homeColumnWidth, orientationOf, RAIL_WIDTH } from './windowRule';

/**
 * The signed-in app's frame. In a wide window Home is docked in a column to the left of the stack;
 * otherwise the stack fills the window and its root is Home. The stack keeps its place in the tree
 * either way, so folding, unfolding and collapsing only change widths: nothing open is remounted.
 */
export function WideFrame({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const wide = useWideLayout(state => state.wide);
  const laidOut = useWideLayout(state => state.window);
  const width = laidOut.width;
  const orientation = orientationOf(laidOut);
  const dragged = useWideLayout(state => state.columnWidths[orientation]);
  const setColumnWidth = useWideLayout(state => state.setColumnWidth);
  const rail = useRail();
  const column = homeColumnWidth(width, dragged);
  const range = columnRange(width);
  const setWindow = useWideLayout(state => state.setWindow);
  const setStack = useWideLayout(state => state.setStack);
  const navigation = useNavigationContainerRef();
  useEffect(() => {
    let before = navigation.getRootState();
    const note = () => {
      const root = navigation.getRootState();
      setStack(root);
      if (useWideLayout.getState().wide && closedAny(before, root)) noteScreenClosed();
      before = root;
    };
    note();
    return navigation.addListener('state', note);
  }, [navigation, setStack]);

  return (
    <ArchiveHoldProvider>
      {/* What is really laid out, not the reported window: React Native can report a stale size on a fold. */}
      {/* Side by side, the column and the open screen keep clear of a cutout on either side. */}
      <View style={[styles.row, wide && { paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: theme.colors.background }]} onLayout={({ nativeEvent: { layout } }) => setWindow({ width: layout.width, height: layout.height })}>
        {wide ? (
          <View key="home" testID="home-column" style={[styles.column, { width: rail ? RAIL_WIDTH : column, backgroundColor: theme.colors.background, borderRightColor: theme.colors.border }]}>
            <InColumn value>
              {/* The column is always in view, whatever the stack shows. */}
              <ScreenFocus value>
                <HomeScreen />
              </ScreenFocus>
            </InColumn>
          </View>
        ) : null}
        <View key="stack" style={styles.fill}>{children}</View>
        {wide && !rail ? (
          <ColumnHandle
            left={insets.left + column}
            width={column}
            min={range.min}
            max={range.max}
            onResize={next => setColumnWidth(orientation, next)}
            onReset={() => setColumnWidth(orientation, null)}
          />
        ) : null}
      </View>
    </ArchiveHoldProvider>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  column: { borderRightWidth: StyleSheet.hairlineWidth },
  fill: { flex: 1 },
});
