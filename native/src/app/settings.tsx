import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { useDaemon } from '@/daemon';
import { PRIVACY_POLICY_URL } from '@/features/app/privacyPolicy';
import { useAffordances } from '@/features/hosts/hostSettings';
import type { Machine } from '@/features/machines/machines';
import { MachineMark } from '@/features/machines/MachineMark';
import { useMachines, useSelectMachine } from '@/features/machines/useMachines';
import { usePushSetup } from '@/features/notifications/usePushSetup';
import { AppUpdateRow } from '@/features/updates/AppUpdateRow';
import { useTheme } from '@/theme';
import { Icon, ListRow, ListSection, Screen, Text } from '@/ui';

/**
 * Settings: the current machine on top, every other machine one tap away, then what's saved on
 * the current machine ("on studio-mac") and what's about the app.
 */
export default function SettingsScreen() {
  const theme = useTheme();
  const { profile } = useDaemon();
  const machines = useMachines();
  const { select, connecting } = useSelectMachine();
  const affordances = useAffordances();
  const current = machines.find(machine => machine.current);
  const others = machines.filter(machine => !machine.current);
  const shortcuts = affordances.data?.terminalShortcuts?.length;
  const on = `on ${profile.label}`;

  return (
    <Screen scroll grouped testID="settings-screen">
      {current ? <HeroCard machine={current} /> : null}

      <ListSection title="Switch to">
        {others.map(machine => (
          <ListRow
            key={machine.key}
            testID={`settings-machine-${machine.name}`}
            title={machine.name}
            subtitle={connecting === machine.tailnet?.name ? 'Connecting…' : machine.status}
            leading={<MachineMark os={machine.os} slot={machine.slot} state={machine.state} variant="tile" size={30} />}
            onPress={machine.selectable ? () => select(machine) : undefined}
            onLongPress={() => router.push({ pathname: '/machine/[key]', params: { key: machine.key } })}
            trailing={<DetailsButton machine={machine} />}
          />
        ))}
        <ListRow
          testID="settings-add-machine"
          title="Add a machine"
          accent
          leading={<View style={[styles.addTile, { backgroundColor: theme.colors.selected }]}><Icon ios="plus" android="add" size={14} color={theme.colors.accentText} /></View>}
          onPress={() => router.push('/computers')}
        />
      </ListSection>

      <ListSection title="General" titleSuffix={on}>
        {profile.tailnetMachine
          ? <ListRow testID="settings-notifications" title="Notifications" value="Needs a code" leading={<RowIcon ios="bell" android="notifications" />} trailing="chevron" onPress={() => router.push('/settings/notifications')} />
          : <NotificationsRow />}
        <ListRow testID="settings-glasses" title="Glasses" value="Even G2" leading={<RowIcon ios="eyeglasses" android="eyeglasses" />} trailing="chevron" onPress={() => router.push('/settings/glasses')} />
      </ListSection>

      <ListSection title="Composer" titleSuffix={on} footer="Saved on the machine, so desktop sees the same settings.">
        <ListRow
          testID="settings-shortcuts"
          title="Shortcuts"
          value={shortcuts === undefined ? undefined : String(shortcuts)}
          leading={<RowIcon ios="bolt" android="bolt" />}
          trailing="chevron"
          onPress={() => router.push('/settings/shortcuts')}
        />
        <ListRow testID="settings-voice" title="Voice" leading={<RowIcon ios="mic" android="mic" />} trailing="chevron" onPress={() => router.push('/settings/voice')} />
      </ListSection>

      <ListSection title="About">
        <AppUpdateRow />
        <ListRow testID="settings-privacy" title="Privacy Policy" trailing="chevron" onPress={() => void Linking.openURL(PRIVACY_POLICY_URL)} />
      </ListSection>
    </Screen>
  );
}

/** The current machine: its mark, name and state. Tapping it opens Machine details. */
function HeroCard({ machine }: { machine: Machine }) {
  const theme = useTheme();
  const { connection } = useDaemon();
  return (
    <View>
      <Pressable
        testID="settings-current-host"
        accessibilityRole="button"
        accessibilityLabel={`${machine.name}, ${machine.os ?? 'Computer'}, ${machine.status}`}
        accessibilityHint="Opens machine details"
        onPress={() => router.push({ pathname: '/machine/[key]', params: { key: machine.key } })}
        style={({ pressed }) => [styles.hero, {
          borderRadius: theme.radius.hero,
          borderColor: theme.colors.cardBorder,
          backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.card,
        }]}
      >
        <MachineMark os={machine.os} slot={machine.slot} state={machine.state} variant="tile" size={44} />
        <View style={styles.heroText}>
          <Text variant="title" numberOfLines={1} style={styles.heroName}>{machine.name}</Text>
          <Text testID={`connection-status-${connection.status}`} variant="subhead" tone="muted" numberOfLines={1}>
            {`${machine.os ?? 'Computer'} · ${connection.updateIntent && connection.status !== 'connected' ? 'Updating Pane…' : machine.status}`}
          </Text>
        </View>
        <Icon ios="info.circle" android="info" size={22} color={theme.colors.accentText} />
      </Pressable>
      {connection.lastError ? <Text variant="footnote" tone="muted" style={styles.heroFooter}>{connection.lastError}</Text> : null}
    </View>
  );
}

function DetailsButton({ machine }: { machine: Machine }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={`settings-machine-details-${machine.name}`}
      accessibilityRole="button"
      accessibilityLabel={`${machine.name} details`}
      hitSlop={10}
      onPress={() => router.push({ pathname: '/machine/[key]', params: { key: machine.key } })}
    >
      <Icon ios="info.circle" android="info" size={20} color={theme.colors.accentText} />
    </Pressable>
  );
}

/** Notifications for a machine paired with a code: "On" once this phone is registered with it. */
function NotificationsRow() {
  const setup = usePushSetup();
  const state = setup.data?.state;
  const value = state === 'registered' ? 'On' : state === 'denied' ? 'Off' : state ? 'Not set up' : undefined;
  return (
    <ListRow
      testID="settings-notifications"
      title="Notifications"
      value={value}
      leading={<RowIcon ios="bell" android="notifications" />}
      trailing="chevron"
      onPress={() => router.push('/settings/notifications')}
    />
  );
}

function RowIcon({ ios, android }: { ios: Parameters<typeof Icon>[0]['ios']; android: Parameters<typeof Icon>[0]['android'] }) {
  const theme = useTheme();
  return <Icon ios={ios} android={android} size={20} color={theme.colors.textSecondary} />;
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18, borderWidth: StyleSheet.hairlineWidth },
  heroText: { flex: 1, gap: 2 },
  heroName: { fontSize: 22, fontWeight: '700' },
  heroFooter: { paddingHorizontal: 4, paddingTop: 6 },
  addTile: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
