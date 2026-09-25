import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { usePairing } from '@/features/pairing/usePairing';
import { useTheme } from '@/theme';
import { Button, EmptyState, Text } from '@/ui';

export default function ScanScreen() {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  // Close the scanner and any "Add host" modal under it.
  const pairing = usePairing(() => router.dismissAll());
  const lastCode = useRef<string | null>(null);

  if (!permission) return <View style={[styles.fill, { backgroundColor: 'black' }]} />;

  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.fill, { backgroundColor: theme.colors.background }]}>
        <EmptyState
          title="Camera access"
          message="Pane needs the camera to scan the connection code on your computer's screen."
          action={
            <View style={styles.actions}>
              {permission.canAskAgain
                ? <Button title="Allow camera" onPress={() => void requestPermission()} />
                : <Text tone="muted" style={styles.center}>Turn on camera access for Pane in Settings.</Text>}
              <Button title="Cancel" variant="plain" onPress={() => router.back()} />
            </View>
          }
        />
      </SafeAreaView>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: 'black' }]}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (pairing.isPending || !data.startsWith('pane-remote://') || data === lastCode.current) return;
          lastCode.current = data;
          pairing.mutate(data);
        }}
      />
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <Text variant="headline" style={styles.caption}>
          {pairing.isPending ? 'Connecting…' : 'Point the camera at the Pane connection code'}
        </Text>
        <View style={styles.frame} />
        {pairing.error ? <Text variant="footnote" style={styles.error}>{pairing.error.message}</Text> : null}
        <Button title="Cancel" variant="secondary" onPress={() => router.back()} />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  overlay: { flex: 1, justifyContent: 'space-between', padding: 24, alignItems: 'stretch' },
  caption: { color: 'white', textAlign: 'center', marginTop: 16 },
  frame: { alignSelf: 'center', width: 240, height: 240, borderRadius: 24, borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)' },
  error: { color: '#ffb4ab', textAlign: 'center' },
  actions: { gap: 8 },
  center: { textAlign: 'center' },
});
