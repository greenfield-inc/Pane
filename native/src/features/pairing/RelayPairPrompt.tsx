import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { RelayPairingError, type RelayPairingLink } from '@shared/remoteClient';

import { Button, Text } from '@/ui';

import { usePairing } from './usePairing';

/**
 * A pairing QR opened from the phone's camera or the browser landing: one tap pairs. It never
 * pairs on its own, since a link could come from anyone.
 */
export function RelayPairPrompt({ code, link, onPaired }: { code: string; link: RelayPairingLink; onPaired?: () => void }) {
  const pairing = usePairing(onPaired);
  const error = pairing.error;
  return (
    <View style={styles.container} testID="relay-pair">
      <Text variant="title">{error ? errorTitle(error) : `Pair with ${link.name}`}</Text>
      <Text variant="callout" tone="secondary">
        {error ? errorDetail(error) : `Watch and steer the agents on ${link.name} from this phone, from any network.`}
      </Text>
      {error instanceof RelayPairingError && error.scanAgain ? (
        <Button testID="relay-pair-scan" title="Scan the new code" onPress={() => router.replace('/scan')} />
      ) : (
        <Button testID="relay-pair-confirm" title={error ? 'Try again' : 'Pair'} loading={pairing.isPending} onPress={() => pairing.mutate(code)} />
      )}
    </View>
  );
}

export function errorTitle(error: Error): string {
  return error instanceof RelayPairingError ? error.message : 'Couldn’t pair';
}

export function errorDetail(error: Error): string {
  return error instanceof RelayPairingError ? error.detail : error.message;
}

const styles = StyleSheet.create({
  container: { gap: 12, paddingTop: 8 },
});
