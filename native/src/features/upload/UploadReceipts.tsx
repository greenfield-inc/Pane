import { Image, Pressable, StyleSheet, View } from 'react-native';

import { useDaemon } from '@/daemon';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import type { UploadReceipt } from './useUploads';

export interface UploadReceiptsProps {
  receipts: readonly UploadReceipt[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}

/** One line per upload above the input: progress the host has confirmed, then done, paused or failed. */
export function UploadReceipts({ receipts, onCancel, onRetry }: UploadReceiptsProps) {
  if (receipts.length === 0) return null;
  return (
    <View style={styles.list} testID="upload-receipts">
      {receipts.map(receipt => <Receipt key={receipt.id} receipt={receipt} onCancel={onCancel} onRetry={onRetry} />)}
    </View>
  );
}

function Receipt({ receipt, onCancel, onRetry }: { receipt: UploadReceipt; onCancel: (id: string) => void; onRetry: (id: string) => void }) {
  const theme = useTheme();
  const { colors } = theme;
  const { profile } = useDaemon();
  const percent = receipt.totalBytes > 0 ? Math.floor((receipt.receivedBytes / receipt.totalBytes) * 100) : 0;
  const detail = {
    queued: 'waiting',
    uploading: `uploading ${percent}% · ${formatBytes(receipt.receivedBytes)} of ${formatBytes(receipt.totalBytes)}`,
    retrying: receipt.paused ? `Paused, retrying · ${percent}%` : `Reconnecting · ${percent}%`,
    failed: receipt.error ?? 'Upload failed',
    done: `on ${profile.label}`,
  }[receipt.state];
  const showRetry = receipt.state === 'failed' || receipt.paused;

  return (
    <View
      testID={`upload-receipt-${receipt.state}`}
      accessibilityLabel={`${receipt.name}, ${detail}`}
      style={[styles.receipt, { borderRadius: theme.radius.md, borderColor: colors.border, backgroundColor: colors.surfaceRaised }]}
    >
      {receipt.isImage ? (
        <Image source={{ uri: receipt.uri }} style={[styles.thumb, { borderRadius: theme.radius.sm }]} />
      ) : (
        <View style={[styles.thumb, styles.center, { borderRadius: theme.radius.sm, backgroundColor: colors.surfacePressed }]}>
          <Icon ios="doc" android="description" size={16} color={colors.textSecondary} />
        </View>
      )}
      <View style={styles.body}>
        <Text variant="footnote" numberOfLines={1}>
          <Text variant="footnote" style={styles.name}>{receipt.name}</Text>
          {receipt.state === 'done' ? <Text variant="footnote" tone="muted">{` · ${detail}`}</Text> : null}
        </Text>
        {receipt.state === 'done' ? (
          <Text variant="footnote" tone="muted">Path inserted at the cursor</Text>
        ) : (
          <Text variant="footnote" tone={receipt.state === 'failed' ? 'danger' : 'muted'} numberOfLines={2}>{detail}</Text>
        )}
        {receipt.state === 'uploading' || receipt.state === 'retrying' ? (
          <View style={[styles.track, { backgroundColor: colors.surfacePressed }]}>
            <View style={[styles.fillBar, { width: `${percent}%`, backgroundColor: colors.accent }]} />
          </View>
        ) : null}
      </View>
      {showRetry ? (
        <Pressable
          testID="upload-retry"
          accessibilityRole="button"
          accessibilityLabel={receipt.state === 'failed' ? `Retry ${receipt.name}` : `Retry ${receipt.name} now`}
          hitSlop={8}
          onPress={() => onRetry(receipt.id)}
          style={styles.action}
        >
          <Text variant="footnote" tone="accent" style={styles.name}>{receipt.state === 'failed' ? 'Retry' : 'Retry now'}</Text>
        </Pressable>
      ) : null}
      {receipt.state === 'done' ? (
        <Icon ios="checkmark" android="check" size={16} color={colors.success} />
      ) : (
        <Pressable
          testID="upload-cancel"
          accessibilityRole="button"
          accessibilityLabel={`Cancel ${receipt.name}`}
          hitSlop={10}
          onPress={() => onCancel(receipt.id)}
          style={styles.action}
        >
          <Icon ios="xmark" android="close" size={14} color={colors.textMuted} />
        </Pressable>
      )}
    </View>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  list: { gap: 6 },
  receipt: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 6 },
  thumb: { width: 28, height: 28 },
  center: { alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0 },
  name: { fontWeight: '600' },
  track: { height: 3, borderRadius: 2, marginTop: 4, overflow: 'hidden' },
  fillBar: { height: '100%' },
  action: { paddingHorizontal: 2 },
});
