import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, View } from 'react-native';

import { useGlasses } from '@/features/glasses/useGlasses';
import { useTheme } from '@/theme';
import { Button, ErrorState, ListRow, ListSection, Screen, Text } from '@/ui';

/** Where a stranger learns to use Pane on Even G2; the repo docs page, published with each merge. */
const GLASSES_DOCS_URL = 'https://github.com/greenfield-inc/Pane/blob/main/docs/EVEN_G2_GLASSES.md';
/** Opens the Even Realities app. It carries no data: the code travels by clipboard. */
const EVEN_APP_URL = 'evenapp://';

/**
 * Settings › Glasses: pairs Even G2 glasses with every computer on this phone's Tailscale login at
 * once. Each computer gives a single-use secret; the phone copies them as one 10-minute code, and
 * the glasses trade each secret for their own token. Lists and revokes the glasses everywhere.
 */
export default function GlassesSettingsScreen() {
  const theme = useTheme();
  const { directory, machines, computers, skipped, deviceName, paired, pair, revoke } = useGlasses();
  const [openError, setOpenError] = useState<string | null>(null);

  if (!directory) {
    return (
      <Screen scroll testID="glasses-settings">
        <ListSection title="Glasses" footer="Glasses pair with the computers this phone reaches over Tailscale.">
          <ListRow testID="glasses-find-computers" title="Find Your Computers" trailing="chevron" onPress={() => router.push('/computers')} />
        </ListSection>
      </Screen>
    );
  }

  const devices = paired.data?.computers ?? [];
  const pairedOn = devices.filter(entry => entry.device);
  const isPaired = pairedOn.length > 0;
  // Full DNS names, which can include computers on another tailnet; shown by their short name.
  const pending = paired.data?.pending ?? [];

  const openEven = async () => {
    setOpenError(null);
    try {
      await Linking.openURL(EVEN_APP_URL);
    } catch {
      setOpenError('Could not open the Even Realities app. Open it yourself, then open Pane there.');
    }
  };

  const confirmRevoke = () => {
    Alert.alert(
      `Revoke ${deviceName}?`,
      'These glasses lose access to every computer. Pair again to use them.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Revoke', style: 'destructive', onPress: () => revoke.mutate() },
      ],
    );
  };

  return (
    <Screen scroll testID="glasses-settings">
      <ListSection
        title="Glasses"
        footer={isPaired ? undefined : 'Pair Even G2 glasses with all your computers.'}
      >
        {isPaired ? (
          <ListRow testID="glasses-device" title={deviceName} subtitle={`${pairedOn.length} ${pairedOn.length === 1 ? 'computer' : 'computers'}`} />
        ) : null}
        {machines.isPending ? <ActivityIndicator color={theme.colors.textMuted} /> : null}
        {machines.isError ? <ErrorState error={machines.error} onRetry={() => void machines.refetch()} /> : null}
        {machines.data && !machines.data.ok ? <Text variant="footnote" tone="secondary">{machines.data.reason}. {machines.data.fix}</Text> : null}
        {computers.map(({ machine }) => {
          const entry = devices.find(candidate => candidate.name === machine.name);
          const status = pending.includes(machine.dnsName)
            ? 'revoke pending'
            : entry?.device
              ? `paired${entry.device.lastUsedAt ? `, last used ${new Date(entry.device.lastUsedAt).toLocaleString()}` : ''}`
              : entry?.problem ?? 'ready';
          return <ListRow key={machine.name} testID={`glasses-computer-${machine.name}`} title={machine.name} subtitle={status} />;
        })}
        {skipped.map(skip => (
          <ListRow key={skip.name} testID={`glasses-computer-${skip.name}`} title={skip.name} subtitle={pending.includes(skip.dnsName) ? 'revoke pending' : `${skip.reason}, skipped`} />
        ))}
      </ListSection>

      <View style={styles.actions}>
        <Button
          testID="glasses-pair"
          title={isPaired ? 'Add Computers' : 'Pair Glasses'}
          loading={pair.isPending}
          disabled={computers.length === 0}
          onPress={() => pair.mutate()}
        />
        <Text variant="footnote" tone="muted">
          Makes one key per computer for these glasses. You can revoke it here or on the computer.
        </Text>
      </View>

      {pair.data?.code ? (
        <ListSection title="Code copied" footer="Next: in the Even app, open Pane and tap Paste.">
          <ListRow testID="glasses-code-copied" title="Pairing code copied" subtitle={`It works for 10 minutes, on ${pair.data.paired.join(', ')}.`} />
          <ListRow testID="glasses-open-even" title="Open Even App" trailing="chevron" onPress={() => void openEven()} />
        </ListSection>
      ) : null}
      {pair.data && !pair.data.code ? (
        <Text variant="footnote" tone="danger" testID="glasses-pair-failed">
          No computer gave a pairing code. {pair.data.skipped.map(skip => `${skip.name}: ${skip.reason}`).join('. ')}
        </Text>
      ) : null}
      {pair.data?.code && pair.data.skipped.length > 0 ? (
        <Text variant="footnote" tone="secondary">Skipped {pair.data.skipped.map(skip => `${skip.name} (${skip.reason})`).join(', ')}.</Text>
      ) : null}
      {pair.error ? <Text variant="footnote" tone="danger">{pair.error.message}</Text> : null}
      {openError ? <Text variant="footnote" tone="danger">{openError}</Text> : null}

      {isPaired || pending.length > 0 ? (
        <ListSection footer={pending.length > 0 ? `Revoke pending on ${pending.map(dnsName => dnsName.split('.')[0]).join(', ')}; it finishes when ${pending.length === 1 ? 'it answers' : 'they answer'}. Each computer can also revoke in Settings › Remote Access › Glasses.` : undefined}>
          <ListRow testID="glasses-revoke" title="Revoke Glasses" destructive onPress={confirmRevoke} />
        </ListSection>
      ) : null}

      <ListSection>
        <ListRow testID="glasses-help" title="How Pane Works on Even G2" trailing="chevron" onPress={() => void Linking.openURL(GLASSES_DOCS_URL)} />
      </ListSection>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { gap: 8 },
});
