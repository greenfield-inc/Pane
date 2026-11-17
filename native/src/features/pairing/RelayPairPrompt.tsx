import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { DEFAULT_RELAY_DOMAIN, RelayPairingError, type RelayPairingLink } from '@shared/remoteClient';
import { relayLinkJoin, type RelayLinkJoin } from '@shared/remoteClient/relayLinkPreview';

import { useHostsStore } from '@/auth/hostsStore';
import { streamingFetch } from '@/daemon/createClient';
import { Button, ListRow, ListSection, Text } from '@/ui';

import { usePairing } from './usePairing';

/**
 * A pairing QR opened from the phone's camera or the browser landing. A phone that reaches no
 * computers yet, or reaches the link's computer already, pairs at once. A phone that would link
 * its computers with the link's computer asks first, naming both sides; cancelling spends nothing.
 * A link through another relay domain always waits for a tap.
 */
export function RelayPairPrompt({ code, link, onPaired }: { code: string; link: RelayPairingLink; onPaired?: () => void }) {
  const pairing = usePairing(onPaired);
  const { mutate } = pairing;
  // Undefined while the computer's group is read.
  const [join, setJoin] = useState<RelayLinkJoin | null | undefined>(undefined);
  const { secret, computerId, domain, name } = link;
  const ownDomain = domain === DEFAULT_RELAY_DOMAIN;
  useEffect(() => {
    let active = true;
    void relayLinkJoin(streamingFetch, { secret, computerId, domain, name }, useHostsStore.getState().profiles).then(result => {
      if (!active) return;
      setJoin(result);
      if (!result && ownDomain) mutate(code);
    });
    return () => { active = false; };
  }, [code, computerId, domain, mutate, name, ownDomain, secret]);

  const error = pairing.error;
  if (join === undefined || (!error && pairing.isPending && !join)) {
    return (
      <View style={styles.container} testID="relay-pair-checking">
        <Text variant="title">{`Pairing with ${link.name}`}</Text>
        <ActivityIndicator />
      </View>
    );
  }
  if (join && !error) {
    return (
      <View style={styles.container} testID="relay-pair-join">
        <Text variant="title">{`Link this phone with ${join.maker}`}</Text>
        <Text variant="callout" tone="secondary">
          {`Pairing links ${join.maker} with the computers on this phone, and each computer can run agents on the others.`}
        </Text>
        {!ownDomain ? <DomainNote domain={link.domain} /> : null}
        <ListSection title="From this link">
          {join.makerGroup.map(name => <ListRow key={name} title={name} subtitle={name === join.maker ? 'Made this link' : undefined} />)}
        </ListSection>
        <ListSection title="On this phone">
          {join.here.map(name => <ListRow key={name} title={name} />)}
        </ListSection>
        <Button testID="relay-pair-confirm" title={`Link ${join.maker}`} loading={pairing.isPending} onPress={() => mutate(code)} />
        <Button testID="relay-pair-cancel" variant="secondary" title="Not mine, cancel" disabled={pairing.isPending} onPress={() => router.replace('/')} />
      </View>
    );
  }
  return (
    <View style={styles.container} testID="relay-pair">
      <Text variant="title">{error ? errorTitle(error) : `Pair with ${link.name}`}</Text>
      <Text variant="callout" tone="secondary">
        {error ? errorDetail(error) : `Watch and steer the agents on ${link.name} from this phone, from any network.`}
      </Text>
      {!error && !ownDomain ? <DomainNote domain={link.domain} /> : null}
      {error instanceof RelayPairingError && error.scanAgain ? (
        <Button testID="relay-pair-scan" title="Scan the new code" onPress={() => router.replace('/scan')} />
      ) : (
        <Button testID="relay-pair-confirm" title={error ? 'Try again' : 'Pair'} loading={pairing.isPending} onPress={() => mutate(code)} />
      )}
    </View>
  );
}

function DomainNote({ domain }: { domain: string }) {
  return (
    <Text variant="callout" tone="secondary" testID="relay-pair-domain">
      {`This code connects through ${domain}, not Pane’s servers. Pair only if you set that up.`}
    </Text>
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
