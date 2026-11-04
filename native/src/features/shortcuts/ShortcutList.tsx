import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { RemotePwaTerminalShortcut } from '@shared/types/remoteDaemon';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { KeyBadge } from './KeyBadge';

type Shortcut = RemotePwaTerminalShortcut;

/** Row height at the default text size; it grows with the text so nothing clips. */
const ROW = 64;
/** The title and subtitle lines (rowTitle 22 + 1 gap + rowDetail 18) plus 9 above and below. */
const rowHeight = (fontScale: number) => Math.max(ROW, Math.ceil(41 * fontScale + 18));

export interface ShortcutListProps {
  shortcuts: readonly Shortcut[];
  disabled: boolean;
  onReorder: (next: Shortcut[]) => void;
  onToggle: (shortcut: Shortcut, enabled: boolean) => void;
  onOpen: (shortcut: Shortcut) => void;
}

/**
 * The shortcut list as a grouped card. Drag a row's handle to move it; it
 * saves when released. VoiceOver and TalkBack get Move up and Move down.
 */
export function ShortcutList({ shortcuts, disabled, onReorder, onToggle, onOpen }: ShortcutListProps) {
  const theme = useTheme();
  const height = rowHeight(useWindowDimensions().fontScale);
  // While dragging, the order shown here; it saves on release.
  const [dragOrder, setDragOrder] = useState<Shortcut[] | null>(null);
  const dragging = useRef<Shortcut[] | null>(null);
  const shown = dragOrder ?? [...shortcuts];
  // Worklets copy what they capture to the UI thread, so capture the count, not the list.
  const last = shown.length - 1;
  const draggingId = useSharedValue<string | null>(null);
  const translation = useSharedValue(0);
  const startIndex = useSharedValue(0);
  const index = useSharedValue(0);

  const move = (list: Shortcut[], from: number, to: number) => {
    const next = [...list];
    const [item] = next.splice(from, 1);
    if (item) next.splice(to, 0, item);
    return next;
  };
  const begin = () => {
    void Haptics.selectionAsync();
    dragging.current = [...shortcuts];
    setDragOrder(dragging.current);
  };
  const shift = (from: number, to: number) => {
    if (!dragging.current) return;
    void Haptics.selectionAsync();
    dragging.current = move(dragging.current, from, to);
    setDragOrder(dragging.current);
  };
  const finish = () => {
    const order = dragging.current;
    dragging.current = null;
    setDragOrder(null);
    if (order && order.some((item, at) => item.id !== shortcuts[at]?.id)) onReorder(order);
  };

  return (
    <View style={[styles.group, { borderRadius: theme.radius.card, backgroundColor: theme.colors.card, borderColor: theme.colors.cardBorder }]}>
      {shown.map((shortcut, at) => {
        const pan = Gesture.Pan()
          .enabled(!disabled)
          .onStart(() => {
            draggingId.value = shortcut.id;
            startIndex.value = at;
            index.value = at;
            translation.value = 0;
            scheduleOnRN(begin);
          })
          .onUpdate(event => {
            translation.value = event.translationY;
            const target = Math.max(0, Math.min(last, startIndex.value + Math.round(event.translationY / height)));
            if (target !== index.value) {
              scheduleOnRN(shift, index.value, target);
              index.value = target;
            }
          })
          .onFinalize(() => {
            translation.value = withSpring((index.value - startIndex.value) * height, { damping: 20, stiffness: 300 }, () => {
              draggingId.value = null;
              translation.value = 0;
            });
            scheduleOnRN(finish);
          });
        return (
          <Row
            key={shortcut.id}
            shortcut={shortcut}
            first={at === 0}
            lastRow={at === last}
            height={height}
            pan={pan}
            lift={{ draggingId, translation, startIndex, index }}
            disabled={disabled}
            canMoveUp={at > 0}
            canMoveDown={at < last}
            onMove={delta => onReorder(move(shown, at, at + delta))}
            onToggle={enabled => onToggle(shortcut, enabled)}
            onOpen={() => onOpen(shortcut)}
          />
        );
      })}
    </View>
  );
}

function Row({ shortcut, first, lastRow, height, pan, lift, disabled, canMoveUp, canMoveDown, onMove, onToggle, onOpen }: {
  shortcut: Shortcut;
  first: boolean;
  lastRow: boolean;
  height: number;
  pan: ReturnType<typeof Gesture.Pan>;
  lift: {
    draggingId: ReturnType<typeof useSharedValue<string | null>>;
    translation: ReturnType<typeof useSharedValue<number>>;
    startIndex: ReturnType<typeof useSharedValue<number>>;
    index: ReturnType<typeof useSharedValue<number>>;
  };
  disabled: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
  onToggle: (enabled: boolean) => void;
  onOpen: () => void;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const { id } = shortcut;
  // The dragged row follows the finger; the list has already moved it to its
  // new slot, so subtract the slots it has moved.
  const style = useAnimatedStyle(() => {
    const dragging = lift.draggingId.value === id;
    return {
      zIndex: dragging ? 1 : 0,
      transform: [{ translateY: dragging ? lift.translation.value - (lift.index.value - lift.startIndex.value) * height : 0 }],
      opacity: dragging ? 0.92 : 1,
    };
  });

  return (
    <Animated.View
      testID={`shortcut-row-${id}`}
      // The card can't clip (a dragged row lifts out of it), so the end rows round themselves.
      style={[
        styles.row,
        {
          height,
          backgroundColor: colors.card,
          borderTopLeftRadius: first ? theme.radius.card : 0,
          borderTopRightRadius: first ? theme.radius.card : 0,
          borderBottomLeftRadius: lastRow ? theme.radius.card : 0,
          borderBottomRightRadius: lastRow ? theme.radius.card : 0,
        },
        style,
      ]}
    >
      {first ? null : <View style={[styles.separator, { backgroundColor: colors.border }]} />}
      <GestureDetector gesture={pan}>
        <View testID={`shortcut-handle-${id}`} style={[styles.handle, { height }]} hitSlop={8} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <Icon ios="line.3.horizontal" android="drag_indicator" size={16} color={colors.textMuted} />
        </View>
      </GestureDetector>
      <Pressable
        testID={`shortcut-open-${id}`}
        accessibilityRole="button"
        accessibilityLabel={`${shortcut.label}, hotkey letter ${shortcut.key.toUpperCase()}`}
        accessibilityHint="Opens it to edit"
        onPress={onOpen}
        style={[styles.body, { height }]}
        accessibilityActions={[
        { name: 'activate', label: 'Edit' },
        ...(canMoveUp ? [{ name: 'moveUp', label: 'Move up' }] : []),
        ...(canMoveDown ? [{ name: 'moveDown', label: 'Move down' }] : []),
      ]}
      onAccessibilityAction={event => {
        const action = event.nativeEvent.actionName;
        if (action === 'activate') onOpen();
        else if (action === 'moveUp') onMove(-1);
        else if (action === 'moveDown') onMove(1);
      }}
      >
        <Text variant="rowTitle" numberOfLines={1}>{shortcut.label}</Text>
        <Text variant="rowDetail" tone="muted" numberOfLines={1}>{shortcut.text}</Text>
      </Pressable>
      <KeyBadge letter={shortcut.key} />
      {/* A box of the row's height keeps the iOS switch centered. */}
      <View style={[styles.switchBox, { height }]}>
        <Switch
          testID={`shortcut-toggle-${id}`}
          accessibilityLabel={`${shortcut.label} on`}
          value={shortcut.enabled}
          disabled={disabled}
          onValueChange={onToggle}
          trackColor={{ true: colors.success, false: undefined }}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  group: { overflow: 'visible', borderWidth: StyleSheet.hairlineWidth },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingRight: 16,
  },
  handle: { width: 40, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, gap: 1, justifyContent: 'center' },
  switchBox: { justifyContent: 'center' },
  // Inset to the label, past the drag handle (40 + 10).
  separator: { position: 'absolute', top: 0, left: 50, right: 0, height: StyleSheet.hairlineWidth },
});
