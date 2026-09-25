import { Linking, Switch } from 'react-native';

import { useTheme } from '@/theme';
import { ListRow, ListSection } from '@/ui';

import { usePushControls, usePushSetup } from './usePushSetup';

/** The Notifications section of Settings for the active host. */
export function NotificationSettings() {
  const theme = useTheme();
  const setup = usePushSetup();
  const controls = usePushControls();
  const result = setup.data;
  const retry = () => void setup.refetch();

  if (!result) {
    return (
      <ListSection title="Notifications">
        <ListRow testID="notifications-checking" title="Checking…" />
      </ListSection>
    );
  }

  if (result.state === 'registered') {
    const toggle = (key: 'needsInputEnabled' | 'completedEnabled', value: boolean) => controls.mutate({ [key]: value });
    const switchProps = { disabled: controls.isPending, trackColor: { true: theme.colors.accent, false: undefined } };
    return (
      <ListSection
        title="Notifications"
        footer={controls.error?.message ?? 'The host alerts this phone when an agent is blocked or finishes a turn. Alerts never include terminal output.'}
      >
        <ListRow
          title="Needs Input"
          subtitle="An agent is waiting for you"
          trailing={<Switch testID="notifications-needs-input" {...switchProps} value={result.status.needsInputEnabled ?? true} onValueChange={value => toggle('needsInputEnabled', value)} />}
        />
        <ListRow
          title="Finished"
          subtitle="An agent completed its turn"
          trailing={<Switch testID="notifications-completed" {...switchProps} value={result.status.completedEnabled ?? true} onValueChange={value => toggle('completedEnabled', value)} />}
        />
      </ListSection>
    );
  }

  if (result.state === 'denied') {
    return (
      <ListSection title="Notifications" footer="Pane can't alert you while notifications are off for Pane in Settings.">
        <ListRow testID="notifications-denied" title="Turn On in Settings" trailing="chevron" onPress={() => void Linking.openSettings()} />
      </ListSection>
    );
  }

  const footer = result.state === 'host-not-ready'
    ? `${result.message} Add push credentials to the host's service to get alerts on this phone.`
    : result.message;
  return (
    <ListSection title="Notifications" footer={footer}>
      <ListRow
        testID={result.state === 'host-not-ready' ? 'notifications-host-not-ready' : 'notifications-error'}
        title={result.state === 'host-not-ready' ? 'Not Set Up on This Host' : 'Couldn’t Turn On Notifications'}
        trailing={setup.isFetching ? undefined : 'chevron'}
        onPress={setup.isFetching ? undefined : retry}
      />
    </ListSection>
  );
}
