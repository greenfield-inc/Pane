import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Button, Icon, TextField } from '@/ui';
import { useTheme } from '@/theme';

import { usePairing } from './usePairing';

/** Paste or scan a pane-remote:// code. Used on first launch and in "Add host". */
export function ConnectForm({ initialCode = '', onPaired }: { initialCode?: string; onPaired?: () => void }) {
  const theme = useTheme();
  const [code, setCode] = useState(initialCode);
  const pairing = usePairing(onPaired);

  const paste = async () => {
    const text = (await Clipboard.getStringAsync()).trim();
    if (text) setCode(text);
  };

  return (
    <View style={styles.container}>
      <TextField
        testID="connect-code-input"
        label="Connection code"
        placeholder="pane-remote://…"
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
        returnKeyType="go"
        onSubmitEditing={() => { if (code.trim()) pairing.mutate(code); }}
        error={pairing.error ? pairing.error.message : null}
        hint="Run `runpane install daemon` on your computer, or open Pane > Settings > Remote Pane, and copy the code."
      />
      <View style={styles.row}>
        <View style={styles.flex}>
          <Button
            testID="connect-paste"
            title="Paste"
            variant="secondary"
            icon={<Icon ios="doc.on.clipboard" android="content_paste" size={17} color={theme.colors.accentText} />}
            onPress={() => void paste()}
          />
        </View>
        <View style={styles.flex}>
          <Button
            testID="connect-scan"
            title="Scan QR"
            variant="secondary"
            icon={<Icon ios="qrcode.viewfinder" android="qr_code_scanner" size={17} color={theme.colors.accentText} />}
            onPress={() => router.push('/scan')}
          />
        </View>
      </View>
      <Button
        testID="connect-submit"
        title="Connect"
        loading={pairing.isPending}
        disabled={!code.trim()}
        onPress={() => pairing.mutate(code)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 16 },
  row: { flexDirection: 'row', gap: 12 },
  flex: { flex: 1 },
});
