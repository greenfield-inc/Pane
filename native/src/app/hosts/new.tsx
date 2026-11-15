import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Button, Icon, ListRow, ListSection, Screen, Text } from '@/ui';

/** Settings › Add a machine: scan the code in Pane on the computer, or another way to connect. */
export default function AddComputerScreen() {
  const theme = useTheme();
  return (
    <Screen scroll grouped testID="add-computer">
      <View style={styles.intro}>
        <Text variant="callout" tone="secondary">
          Pair this phone with Pane on your computer. On the computer, open Pane and click Pair a phone on Home.
        </Text>
        <Button
          testID="add-computer-scan"
          title="Scan a QR code"
          icon={<Icon ios="qrcode.viewfinder" android="qr_code_scanner" size={16} color={theme.colors.onAccent} />}
          onPress={() => router.push('/scan')}
        />
      </View>
      <ListSection title="Other ways to connect">
        <ListRow testID="add-computer-code" title="Paste a connection code" trailing="chevron" onPress={() => router.push('/hosts/add')} />
        <ListRow testID="add-computer-tailscale" title="Use Tailscale" trailing="chevron" onPress={() => router.push('/computers')} />
      </ListSection>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { gap: 16, marginBottom: 24 },
});
