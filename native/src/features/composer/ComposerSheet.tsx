import { useRef, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

export interface ComposerSheetProps {
  visible: boolean;
  onClose: () => void;
  /** After the sheet has fully closed (iOS); system pickers can only open then. */
  onDismiss?: () => void;
  children: ReactNode;
  testID?: string;
}

/**
 * A short sheet that rises over the terminal for a composer action (attach,
 * shortcuts, copy, voice setup). It stays on the pane's screen, so what it
 * picks goes straight into the draft. Tapping outside closes it.
 */
export function ComposerSheet({ visible, onClose, onDismiss, children, testID }: ComposerSheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} onDismiss={onDismiss} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <Pressable
          testID={testID ? `${testID}-scrim` : undefined}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[styles.fill, { backgroundColor: theme.colors.scrim }]}
          onPress={onClose}
        />
        <View
          testID={testID}
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              borderTopLeftRadius: theme.radius.lg + 4,
              borderTopRightRadius: theme.radius.lg + 4,
              paddingBottom: Math.max(insets.bottom, 16),
            },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: theme.colors.border }]} />
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * For an action that presents something new (a picker, a screen): iOS can't
 * present while a sheet is still sliding away. `afterClose(action)` runs it
 * from the sheet's `onDismiss` on iOS and right away elsewhere; close the
 * sheet in the same handler.
 */
export function useAfterSheetCloses() {
  const pending = useRef<(() => void) | null>(null);
  return {
    afterClose: (action: () => void) => {
      if (Platform.OS === 'ios') pending.current = action;
      else action();
    },
    onDismiss: () => {
      const action = pending.current;
      pending.current = null;
      action?.();
    },
  };
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  sheet: { borderTopWidth: 1, paddingTop: 8, maxHeight: '85%' },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, marginBottom: 8 },
});
