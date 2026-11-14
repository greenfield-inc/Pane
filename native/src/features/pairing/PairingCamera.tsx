import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, type ReactNode } from 'react';
import { AppState, Linking, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { parseRelayPairingLink, RelayPairingError } from '@shared/remoteClient';

import { useTheme } from '@/theme';
import { Button, EmptyState, Text } from '@/ui';

import { errorDetail, errorTitle } from './RelayPairPrompt';
import { usePairing } from './usePairing';

/** A pairing QR (`https://<domain>/pair#…`) or a pane-remote:// connection code. */
function isPairingCode(data: string): boolean {
  return data.startsWith('pane-remote://') || parseRelayPairingLink(data) !== null;
}

/**
 * The camera, pairing with the first code it sees. `actions` sit under it, and stay offered when
 * the camera is off.
 */
export function PairingCamera({ caption, actions, onPaired }: { caption: string; actions: ReactNode; onPaired?: () => void }) {
  const theme = useTheme();
  // Opening the scanner asks iOS or Android directly; the system dialog shows the camera purpose string.
  const [permission, , getPermission] = useCameraPermissions({ request: true });
  const pairing = usePairing(onPaired);
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
          message="Scanning the code uses the camera. You can turn on camera access for Pane in Settings, or paste a connection code instead."
          action={
            <View style={styles.actions}>
              <Button testID="scan-open-settings" title="Open Settings" variant="secondary" onPress={() => void Linking.openSettings()} />
              {actions}
            </View>
          }
        />
      </SafeAreaView>
    );
  }

  const error = pairing.error;
  const scanAgain = () => {
    lastCode.current = null;
    pairing.reset();
  };

  return (
    <View style={[styles.fill, { backgroundColor: 'black' }]}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (pairing.isPending || error || !isPairingCode(data) || data === lastCode.current) return;
          lastCode.current = data;
          pairing.mutate(data);
        }}
      />
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <Text variant="headline" style={styles.caption}>{pairing.isPending ? 'Connecting…' : caption}</Text>
        <View style={styles.frame} />
        <View style={styles.actions}>
          {error ? (
            <View testID="scan-error" accessibilityRole="alert" style={[styles.note, { backgroundColor: theme.colors.surface, borderRadius: theme.radius.md }]}>
              <Text variant="headline">{errorTitle(error)}</Text>
              <Text variant="subhead" tone="secondary">{errorDetail(error)}</Text>
              <Button
                testID="scan-again"
                title={error instanceof RelayPairingError && error.scanAgain ? 'Scan the new code' : 'Try again'}
                onPress={scanAgain}
              />
            </View>
          ) : null}
          {actions}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  overlay: { flex: 1, justifyContent: 'space-between', padding: 24, alignItems: 'stretch' },
  caption: { color: 'white', textAlign: 'center', marginTop: 16 },
  frame: { alignSelf: 'center', width: 240, height: 240, borderRadius: 24, borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)' },
  actions: { gap: 8 },
  note: { padding: 16, gap: 8 },
});
