import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState, Linking, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { usePairing } from '@/features/pairing/usePairing';
import { useTheme } from '@/theme';
import { Button, EmptyState, Text } from '@/ui';

export default function ScanScreen() {
  const theme = useTheme();
  // Opening the scanner asks iOS or Android directly; the system dialog shows the camera purpose string.
  const [permission, , getPermission] = useCameraPermissions({ request: true });
  // Close the scanner and any "Add host" modal under it.
  const pairing = usePairing(() => router.dismissAll());
  const lastCode = useRef<string | null>(null);

  // Pick up a change made in Settings when the person comes back to the app.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void getPermission();
    });
    return () => subscription.remove();
  }, [getPermission]);

  if (!permission || permission.status === 'undetermined') {
    return <View style={[styles.fill, { backgroundColor: 'black' }]} />;
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.fill, { backgroundColor: theme.colors.background }]}>
        <EmptyState
          testID="scan-camera-off"
          title="Camera is off"
          message="Scanning the connection code uses the camera. You can turn on camera access for Pane in Settings, or go back and paste the connection code instead."
          action={
            <View style={styles.actions}>
              <Button testID="scan-open-settings" title="Open Settings" variant="secondary" onPress={() => void Linking.openSettings()} />
              <Button testID="scan-back" title="Back" variant="plain" onPress={() => router.back()} />
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
});
