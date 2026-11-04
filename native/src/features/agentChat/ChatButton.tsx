import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

/** Native 44pt hit target around the upstream button geometry. */
export function ChatButton({ title, onPress, disabled, primary, icon, testID, style }: {
  title: string; onPress: () => void; disabled?: boolean; primary?: boolean;
  icon?: React.ReactNode; testID: string; style?: StyleProp<ViewStyle>;
}) {
  const { chat } = useTheme();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={() => { void Haptics.selectionAsync(); onPress(); }} style={({ pressed }) => [styles.button, { backgroundColor: primary ? chat.primary : chat.muted, opacity: disabled ? 0.5 : pressed ? 0.75 : 1 }, style]}>
    <View style={styles.content}>{icon}<Text variant="callout" style={{ color: primary ? chat.onPrimary : chat.foreground }}>{title}</Text></View>
  </Pressable>;
}
const styles = StyleSheet.create({ button: { minHeight: 44, borderRadius: 22, justifyContent: 'center', paddingHorizontal: 14 }, content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 } });
