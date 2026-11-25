import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { DEFAULT_RELAY_DOMAIN, RelayPairingError, type RelayPairingLink } from '@shared/remoteClient';
import { fullAccessRefusal, linkJoin, type LinkPreviewAnswer, type RelayLinkJoin } from '@shared/remoteClient/relayLinkPreview';
import { DEVICE_ACCESS_LABELS, READ_ONLY_GRANT_HELP } from '@shared/types/accessLevel';

import { isReadOnlyProfile } from '@/auth/access';
import { useHostsStore } from '@/auth/hostsStore';
import { ReadOnlyChip } from '@/features/hosts/ReadOnlyChip';
import { Button, ListRow, ListSection, Text } from '@/ui';

import { previewLink, usePairing } from './usePairing';

/**
 * A pairing QR opened from the phone's camera or the browser landing. A phone that reaches no
 * computers yet, or reaches the link's computer already, pairs at once. A phone that would link
 * its computers with the link's computer asks first, naming both sides; a Read only link says it
 * only watches. Cancelling spends nothing.
 * A link through another relay domain always waits for a tap.
 */
export function RelayPairPrompt({ code, link, onPaired }: { code: string; link: RelayPairingLink; onPaired?: () => void }) {
  const pairing = usePairing(onPaired);
  const { mutate } = pairing;
  // What the link pairs, as the person sees it: pairing uses this answer and no later one. Undefined while it's read.
  const [checked, setChecked] = useState<Checked | undefined>(undefined);
  const [unreachable, setUnreachable] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { secret, computerId, domain, name } = link;
  const ownDomain = domain === DEFAULT_RELAY_DOMAIN;
  useEffect(() => {
    let active = true;
    checkLink({ secret, computerId, domain, name }).then(result => {
      if (!active) return;
      setChecked(result);
      if (!result.join && ownDomain) mutate({ code, preview: result.preview });
    }, (error: Error) => { if (active) setUnreachable(error); });
    return () => { active = false; };
  }, [attempt, code, computerId, domain, mutate, name, ownDomain, secret]);

  const join = checked?.join;
  const error = unreachable ?? pairing.error;
  const pair = () => mutate({ code, preview: checked?.preview });
  const tryAgain = () => {
    if (!unreachable) return pair();
    setUnreachable(null);
    setAttempt(attempt + 1);
  };
  if ((!checked && !error) || (!error && pairing.isPending && !join)) {
    return (
      <View style={styles.container} testID="relay-pair-checking">
        <Text variant="title">{`Pairing with ${link.name}`}</Text>
        <ActivityIndicator />
      </View>
    );
  }
  const watchOnly = join?.access === 'read';
  if (join && !error) {
    return (
      <View style={styles.container} testID="relay-pair-join">
        <Text variant="title">{watchOnly ? `Watch ${join.maker}` : `Link this phone with ${join.maker}`}</Text>
        {watchOnly ? <ReadOnlyChip /> : null}
        <Text variant="callout" tone="secondary">
          {watchOnly
            ? `${READ_ONLY_GRANT_HELP}${join.here.length ? ` The computers already on this phone stay unlinked from ${join.maker}.` : ''}`
            : `Pairing links ${join.maker} with the computers on this phone, and each computer can run agents on the others.`}
        </Text>
        {!ownDomain ? <DomainNote domain={link.domain} /> : null}
        <ListSection title="From this link">
          {join.makerGroup.map(name => <ListRow key={name} title={name} subtitle={name === join.maker ? 'Made this link' : undefined} />)}
        </ListSection>
        {watchOnly ? null : (
          <ListSection title="On this phone">
            {join.here.map(name => <ListRow key={name} title={name} />)}
          </ListSection>
        )}
        <Button testID="relay-pair-confirm" title={watchOnly ? `Pair ${DEVICE_ACCESS_LABELS.read}` : `Link ${join.maker}`} loading={pairing.isPending} onPress={pair} />
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
        <Button testID="relay-pair-confirm" title={error ? 'Try again' : 'Pair'} loading={pairing.isPending} onPress={error ? tryAgain : pair} />
      )}
    </View>
  );
}

interface Checked {
  /** What to confirm; null when it pairs, or is refused (usePairing), without asking. */
  join: RelayLinkJoin | null;
  /** Undefined when nothing was asked yet: a link through another relay domain waits for a tap. */
  preview: LinkPreviewAnswer | undefined;
}

async function checkLink(link: RelayPairingLink): Promise<Checked> {
  const saved = useHostsStore.getState().profiles;
  const links = saved.some(profile => profile.relay && !isReadOnlyProfile(profile));
  if (link.domain !== DEFAULT_RELAY_DOMAIN && !links) return { join: null, preview: undefined };
  const preview = await previewLink(link);
  const join = linkJoin(link, preview, saved);
  if (join) return { join, preview };
  // A link that would pair without asking still asks when it only watches.
  const maker = preview?.group[0]?.name;
  if (!maker || preview.access !== 'read' || fullAccessRefusal('phone', link.computerId, preview.access, saved)) return { join: null, preview };
  return { join: { maker, makerGroup: preview.group.map(computer => computer.name), here: [], access: 'read' }, preview };
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
