import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, View } from 'react-native';

import { useDaemon } from '@/daemon';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { ComposerSheet, useAfterSheetCloses } from '../composer/ComposerSheet';
import type { AttachSource } from './pickFiles';

const SOURCES: { source: AttachSource; label: string; ios: SFSymbol; android: AndroidSymbol }[] = [
  { source: 'photos', label: 'Photos', ios: 'photo.on.rectangle', android: 'photo_library' },
  { source: 'camera', label: 'Camera', ios: 'camera', android: 'photo_camera' },
  { source: 'files', label: 'Files', ios: 'folder', android: 'folder' },
];

/** Photos, Camera or Files. Each picked file is copied to the host and its path goes into the draft. */
export function AttachSheet({ visible, onClose, onPick }: { visible: boolean; onClose: () => void; onPick: (source: AttachSource) => void }) {
  const theme = useTheme();
  const { colors } = theme;
  const { profile } = useDaemon();
  const { afterClose, onDismiss } = useAfterSheetCloses();
  return (
    <ComposerSheet visible={visible} onClose={onClose} onDismiss={onDismiss} testID="attach-sheet">
      <View style={styles.header}>
        <Text variant="headline">Attach</Text>
        <Text variant="subhead" tone="muted" numberOfLines={1} style={styles.shrink}> · copied to {profile.label}</Text>
      </View>
      <View style={styles.grid}>
        {SOURCES.map(item => (
          <Pressable
            key={item.source}
            testID={`attach-${item.source}`}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            onPress={() => {
              void Haptics.selectionAsync();
              afterClose(() => onPick(item.source));
              onClose();
            }}
            style={({ pressed }) => [
              styles.tile,
              { borderRadius: theme.radius.lg, borderColor: colors.border, backgroundColor: pressed ? colors.surfacePressed : colors.surfaceRaised },
            ]}
          >
            <Icon ios={item.ios} android={item.android} size={24} color={colors.text} />
            <Text variant="callout">{item.label}</Text>
          </Pressable>
        ))}
      </View>
      <Text variant="footnote" tone="muted" style={styles.note}>
        Any file type, several at once, up to 50 MB each. Each file's host path goes into your message.
      </Text>
    </ComposerSheet>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: 16, paddingBottom: 12 },
  shrink: { flexShrink: 1 },
  grid: { flexDirection: 'row', gap: 10, paddingHorizontal: 16 },
  tile: { flex: 1, height: 84, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  note: { paddingHorizontal: 16, paddingTop: 12 },
});
