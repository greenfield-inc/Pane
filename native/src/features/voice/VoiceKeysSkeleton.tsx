import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Skeleton } from '@/ui';

/** Voice settings before the computer answers: three of VoiceKeyField's labels and one-row cards. */
export function VoiceKeysSkeleton() {
  const theme = useTheme();
  return (
    <View testID="voice-settings-skeleton" accessible accessibilityLabel="Loading voice keys" style={styles.form}>
      {[0.45, 0.4, 0.6].map(width => (
        <View key={width} style={styles.field}>
          <View style={styles.inset}><Skeleton width={`${width * 100}%`} height={13} style={styles.labelBone} /></View>
          <View style={[styles.keyBox, { borderRadius: theme.radius.card, backgroundColor: theme.colors.card, borderColor: theme.colors.cardBorder }]}>
            <Skeleton width={64} height={16} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 20 },
  inset: { paddingHorizontal: 4 },
  // VoiceKeyField's label and one-row card.
  field: { gap: 6 },
  labelBone: { marginVertical: 2.5 },
  keyBox: { minHeight: 58, justifyContent: 'center', paddingHorizontal: 16, borderWidth: StyleSheet.hairlineWidth },
});
