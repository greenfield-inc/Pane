import { Alert, Linking, Platform, StyleSheet, Switch, View } from 'react-native';

import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { useHostsStore } from '@/auth/hostsStore';
import { isDemoProfile } from '@/features/demo/demoHost';
import { useTheme, type ThemeColors } from '@/theme';
import { ListRow, ListSection } from '@/ui';

import type { PushSetupResult } from './registration';
import { requestPushRegistration, usePushStore } from './usePushSetup';

const SYSTEM_SETTINGS = Platform.OS === 'ios' ? 'iOS Settings' : 'Android Settings';
const PUSH_KEY = Platform.OS === 'ios' ? 'Apple push key' : 'Firebase push key';

/** The phone-wide alert switches, then whether each saved computer can alert this phone. */
export function NotificationSettings() {
  const theme = useTheme();
  const profiles = useHostsStore(state => state.profiles).filter(profile => !isDemoProfile(profile));
  const preferences = usePushStore(state => state.preferences);
  const results = usePushStore(state => state.results);
  const setPreference = usePushStore(state => state.setPreference);

  if (profiles.length === 0) return null;

  const trackColor = { true: theme.colors.accent, false: undefined };
  return (
    <ListSection
      title="Notifications"
      footer="Your computers alert this phone when an agent needs input or finishes a turn. Alerts never include terminal output."
    >
      <ListRow
        title="Needs input"
        subtitle="An agent is waiting for you"
        trailing={<Switch testID="notifications-needs-input" trackColor={trackColor} value={preferences.needsInputEnabled} onValueChange={value => setPreference('needsInputEnabled', value)} />}
      />
      <ListRow
        title="Finished"
        subtitle="An agent completed its turn"
        trailing={<Switch testID="notifications-completed" trackColor={trackColor} value={preferences.completedEnabled} onValueChange={value => setPreference('completedEnabled', value)} />}
      />
      {profiles.map(profile => <ComputerRow key={profile.id} profile={profile} result={results[profile.id]} />)}
    </ListSection>
  );
}

function ComputerRow({ profile, result }: { profile: RemotePaneConnectionProfile; result: PushSetupResult | undefined }) {
  const theme = useTheme();
  const { summary, color, onPress } = present(profile, result);
  return (
    <ListRow
      testID={`notifications-host-${profile.label}`}
      title={profile.label}
      subtitle={summary}
      subtitleLines={2}
      leading={<View style={styles.dotBox}><View style={[styles.dot, { backgroundColor: theme.colors[color] }]} /></View>}
      trailing={onPress ? 'chevron' : undefined}
      onPress={onPress}
    />
  );
}

function present(profile: RemotePaneConnectionProfile, result: PushSetupResult | undefined): { summary: string; color: keyof ThemeColors; onPress?: () => void } {
  if (!result) return { summary: 'Checking…', color: 'neutral' };
  switch (result.state) {
    case 'registered':
      return { summary: 'On', color: 'success' };
    case 'denied':
      return { summary: `Notifications are off in ${SYSTEM_SETTINGS}`, color: 'danger', onPress: () => void Linking.openSettings() };
    case 'unreachable':
      return { summary: 'Can’t reach this computer', color: 'warning', onPress: () => explain(profile, result.message) };
    case 'host-not-ready':
      if (result.provider === 'missing-config') {
        const summary = `No ${PUSH_KEY} on this computer. Load it in Settings › Integrations on any computer.`;
        return { summary, color: 'warning', onPress: () => explain(profile, summary) };
      }
      return { summary: result.message, color: 'warning', onPress: () => explain(profile, result.message) };
    case 'error':
      // A Pane from before codeless alerts refuses a phone that connected without a code.
      if (result.code === 'ERR_MOBILE_PUSH_PAIRING_REQUIRED' && profile.tailnetMachine) {
        const summary = 'Update Pane on this computer to get its alerts here.';
        return { summary, color: 'warning', onPress: () => explain(profile, summary) };
      }
      return { summary: result.message, color: 'danger', onPress: () => explain(profile, result.message) };
  }
}

/** The row holds two lines; the alert shows the whole message. */
function explain(profile: RemotePaneConnectionProfile, message: string): void {
  Alert.alert(profile.label, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Try Again', onPress: requestPushRegistration },
  ]);
}

const styles = StyleSheet.create({
  dotBox: { width: 12, height: 12, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
