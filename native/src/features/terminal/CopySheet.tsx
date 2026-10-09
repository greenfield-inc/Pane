import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { invokeChannel, useDaemon } from '@/daemon';
import { monoFontFamily, useTheme } from '@/theme';
import { Button, Icon, Text } from '@/ui';

import { ComposerSheet } from '../composer/ComposerSheet';

const HISTORY_LINES = 300;

export interface CopySheetProps {
  visible: boolean;
  onClose: () => void;
  panelId: string;
  /** What the terminal shows now; the sheet opens on it. */
  screenText: string;
}

/**
 * The terminal's recent output as selectable text. Last 300 lines copies the
 * host's clean scrollback and shows it, Copy all takes everything shown, and
 * Copy selection takes what is selected.
 */
export function CopySheet({ visible, onClose, panelId, screenText }: CopySheetProps) {
  const theme = useTheme();
  const { colors } = theme;
  const { client } = useDaemon();
  const [history, setHistory] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [status, setStatus] = useState<{ message: string; error: boolean } | null>(null);
  const text = (history ?? screenText).replace(/\s+$/, '');
  const selected = text.slice(selection.start, selection.end);

  const close = () => {
    setHistory(null);
    setStatus(null);
    setSelection({ start: 0, end: 0 });
    onClose();
  };
  const copy = async (value: string, message: string) => {
    await Clipboard.setStringAsync(value);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setStatus({ message, error: false });
  };
  const copyHistory = async () => {
    setLoading(true);
    setStatus(null);
    try {
      const result = await invokeChannel<{ content: string }>(client, 'terminal:getScrollbackClean', [panelId, HISTORY_LINES]);
      const content = result.content.replace(/\s+$/, '');
      if (!content) throw new Error('No output yet.');
      setHistory(content);
      setSelection({ start: 0, end: 0 });
      await copy(content, `Copied the last ${HISTORY_LINES} lines`);
    } catch (cause) {
      setStatus({ message: cause instanceof Error ? cause.message : 'Could not load the scrollback.', error: true });
    } finally {
      setLoading(false);
    }
  };

  return (
    <ComposerSheet visible={visible} onClose={close} testID="copy-sheet">
      <View style={styles.header}>
        <Text variant="headline" accessibilityRole="header">Copy from terminal</Text>
        <Pressable
          testID="copy-all"
          accessibilityRole="button"
          accessibilityLabel="Copy all"
          hitSlop={8}
          disabled={!text}
          onPress={() => void copy(text, 'Copied all')}
        >
          <Text variant="callout" tone="accent" style={styles.link}>Copy all</Text>
        </Pressable>
      </View>
      <View style={[styles.output, { borderRadius: theme.radius.lg, backgroundColor: theme.terminal.background }]}>
        {/* Editable only so iOS and Android allow selecting part of it; edits are ignored. */}
        <TextInput
          testID="copy-output"
          value={text}
          onChangeText={() => undefined}
          onSelectionChange={event => setSelection(event.nativeEvent.selection)}
          showSoftInputOnFocus={false}
          multiline
          scrollEnabled
          autoCorrect={false}
          spellCheck={false}
          selectionColor={theme.terminal.selectionBackground}
          placeholder="No output yet"
          placeholderTextColor={theme.terminal.brightBlack}
          style={[styles.text, { color: theme.terminal.foreground, fontFamily: monoFontFamily }]}
        />
      </View>
      {status ? (
        <View style={styles.status} accessibilityLiveRegion="polite">
          {status.error ? null : <Icon ios="checkmark" android="check" size={14} color={colors.success} />}
          <Text variant="footnote" tone={status.error ? 'danger' : 'secondary'}>{status.message}</Text>
        </View>
      ) : null}
      <View style={styles.buttons}>
        <View style={styles.button}>
          <Button
            testID="copy-history"
            title={`Last ${HISTORY_LINES} lines`}
            icon={<Icon ios="doc.on.doc" android="content_copy" size={15} color={colors.onAccent} />}
            loading={loading}
            onPress={() => void copyHistory()}
          />
        </View>
        <View style={styles.button}>
          <Button
            testID="copy-selection"
            title="Copy selection"
            variant="secondary"
            disabled={!selected}
            onPress={() => void copy(selected, 'Copied selection')}
          />
        </View>
      </View>
    </ComposerSheet>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12 },
  link: { fontWeight: '600' },
  output: { marginHorizontal: 12, height: 260, overflow: 'hidden' },
  text: { flex: 1, padding: 12, fontSize: 12, lineHeight: 17 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingTop: 10 },
  buttons: { flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingTop: 12 },
  button: { flex: 1 },
});
