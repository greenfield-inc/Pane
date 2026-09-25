import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Button, Icon, Text, TextField } from '@/ui';
import { useTheme } from '@/theme';

import { describeConnectionCode } from './describeCode';
import { usePairing } from './usePairing';

/**
 * The PWA's connection form (RemoteConnectionScreen): a "Connection Code"
 * box and one button that reads "Paste & Connect" while the box is empty.
 * Native additions: Scan QR, and a preview of the host the code points at.
 */
export function ConnectForm({ initialCode = '', onPaired }: { initialCode?: string; onPaired?: () => void }) {
  const theme = useTheme();
  const [code, setCode] = useState(initialCode);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const pairing = usePairing(onPaired);
  const host = describeConnectionCode(code);
  const trimmed = code.trim();

  const submit = async () => {
    setClipboardError(null);
    if (trimmed) {
      pairing.mutate(trimmed);
      return;
    }
    const pasted = (await Clipboard.getStringAsync()).trim();
    if (!pasted) {
      setClipboardError('The clipboard is empty. Copy a pane-remote:// code first.');
      return;
    }
    setCode(pasted);
    pairing.mutate(pasted);
  };

  const error = pairing.error?.message ?? clipboardError;

  return (
    <View style={styles.container}>
      <TextField
        testID="connect-code-input"
        label="Connection Code"
        placeholder="pane-remote://..."
        value={code}
        onChangeText={setCode}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        // The code holds a bearer token: keep it out of keyboard suggestions,
        // the learned dictionary and autofill.
        autoComplete="off"
        importantForAutofill="no"
        keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
        mono
        multiline
        style={styles.codeInput}
      />
      {error ? (
        <View
          accessibilityRole="alert"
          style={[styles.error, { borderColor: theme.colors.danger, backgroundColor: `${theme.colors.danger}14`, borderRadius: theme.radius.md }]}
        >
          <Text variant="subhead" tone="danger">{error}</Text>
        </View>
      ) : null}
      <Button
        testID="connect-submit"
        title={pairing.isPending ? 'Connecting...' : trimmed ? 'Import & Connect' : 'Paste & Connect'}
        loading={pairing.isPending}
        icon={<Icon ios={trimmed ? 'arrow.right' : 'doc.on.clipboard'} android={trimmed ? 'arrow_forward' : 'content_paste'} size={16} color={theme.colors.onAccent} />}
        onPress={() => void submit()}
      />
      <Button
        testID="connect-scan"
        title="Scan QR Code"
        variant="secondary"
        icon={<Icon ios="qrcode.viewfinder" android="qr_code_scanner" size={16} color={theme.colors.text} />}
        onPress={() => router.push('/scan')}
      />
      {host ? (
        <View testID="connect-host" style={[styles.host, { backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.border, borderRadius: theme.radius.md }]}>
          <Text variant="footnote" tone="muted">Connects to</Text>
          <Text variant="callout" numberOfLines={1} style={styles.semibold}>{host.label}</Text>
          <Text variant="footnote" tone="secondary" numberOfLines={1}>{host.baseUrl}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 16 },
  // min-h-32 max-h-52
  codeInput: { minHeight: 128, maxHeight: 208, textAlignVertical: 'top' },
  error: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  host: { borderWidth: 1, padding: 12, gap: 2 },
  semibold: { fontWeight: '600' },
});
