import { LegendList } from '@legendapp/list/react-native';
import { useState, type ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';

import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import type { TailnetMachine } from '@shared/types/workspaceAccess';

import { passwordProblem } from '@/auth/computers';
import { useActiveHost } from '@/auth/hostsStore';
import { useTheme } from '@/theme';
import { Button, Text, TextField } from '@/ui';

import { OsLogo } from './OsLogo';
import { useComputers, useConnectComputer } from './useComputers';

// The same words desktop Pane uses under Settings › Remote Access › Your computers.
const STATE_TEXT = {
  available: 'Ready',
  'password-required': 'Needs password',
  outdated: 'Older Pane',
  unreachable: 'Pane not open',
  offline: 'Offline',
} satisfies Record<TailnetMachine['state'], string>;

interface ComputerListProps {
  /** A computer this phone can reach, asked for the list. */
  directory: RemotePaneConnectionProfile | null;
  /** Above the list, such as the "Find your computers" form. */
  header?: ReactElement;
  onConnected?: () => void;
}

/** Your computers on Tailscale, as desktop Pane lists them: tap Connect, no code. */
export function ComputerList({ directory, header, onConnected }: ComputerListProps) {
  const theme = useTheme();
  const computers = useComputers(directory);
  const connect = useConnectComputer(onConnected);
  const active = useActiveHost();
  const [password, setPassword] = useState<{ name: string; value: string } | null>(null);

  const list = computers.data;
  const machines = list?.ok ? list.machines : [];
  const domain = list?.ok ? list.domain : null;
  const failure = connect.error && connect.variables ? { name: connect.variables.machine.name, problem: passwordProblem(connect.error) } : null;

  const start = (machine: TailnetMachine, value?: string) => {
    if (!domain) return;
    connect.mutate({ machine, domain, password: value });
  };

  const renderItem = ({ item: machine }: { item: TailnetMachine }) => {
    const connected = active?.tailnetMachine === machine.name && active.tailnetDomain === domain;
    const connectable = machine.state !== 'offline' && machine.state !== 'unreachable';
    const pending = connect.isPending && connect.variables?.machine.name === machine.name;
    // Ask for the password when the computer says it needs one, or rejected the last one.
    const askPassword = password?.name === machine.name
      || (failure?.name === machine.name && failure.problem !== null);
    const detail = [STATE_TEXT[machine.state], machine.mine ? null : machine.ownerLogin].filter(Boolean).join(' · ');
    const rowError = failure?.name === machine.name
      ? failure.problem === 'invalid' ? 'That password is wrong.' : failure.problem ? null : connect.error?.message
      : null;

    return (
      <View testID={`computer-${machine.name}`} style={[styles.row, { borderColor: theme.colors.border }]}>
        <View style={styles.summary}>
          <OsLogo os={machine.os} />
          <View style={styles.text}>
            <Text variant="body" numberOfLines={1}>{machine.name}</Text>
            <Text variant="footnote" tone="muted" numberOfLines={1}>{detail}</Text>
          </View>
          {askPassword ? null : (
            <Button
              testID={`computer-connect-${machine.name}`}
              title={connected ? 'Connected' : 'Connect'}
              variant={connected ? 'secondary' : 'primary'}
              disabled={connected || !connectable || connect.isPending}
              loading={pending}
              onPress={() => (machine.state === 'password-required'
                ? setPassword({ name: machine.name, value: '' })
                : start(machine))}
            />
          )}
        </View>
        {askPassword ? (
          <View style={styles.password}>
            <TextField
              testID={`computer-password-${machine.name}`}
              placeholder="Password"
              value={password?.name === machine.name ? password.value : ''}
              onChangeText={value => setPassword({ name: machine.name, value })}
              secureTextEntry
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={() => start(machine, password?.value)}
            />
            <View style={styles.actions}>
              <Button title="Cancel" variant="plain" onPress={() => { setPassword(null); connect.reset(); }} />
              <Button
                testID={`computer-password-connect-${machine.name}`}
                title="Connect"
                loading={pending}
                disabled={!password?.value}
                onPress={() => start(machine, password?.value)}
              />
            </View>
          </View>
        ) : null}
        {rowError ? <Text variant="footnote" tone="danger">{rowError}</Text> : null}
      </View>
    );
  };

  return (
    <LegendList
      testID="computers-list"
      data={machines}
      keyExtractor={machine => machine.dnsName}
      estimatedItemSize={64}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshing={computers.isRefetching}
      onRefresh={() => void computers.refetch()}
      contentContainerStyle={styles.content}
      renderItem={renderItem}
      ListHeaderComponent={(
        <View style={styles.header}>
          {header}
          {list?.ok ? <Text variant="footnote" tone="muted">On {list.tailnet}</Text> : null}
          {computers.isLoading ? <Text variant="subhead" tone="secondary">Looking for your computers…</Text> : null}
          {list && !list.ok ? <Text variant="subhead" tone="danger">{list.reason}. {list.fix}</Text> : null}
          {computers.error ? <Text variant="subhead" tone="danger">{computers.error.message}</Text> : null}
        </View>
      )}
      ListEmptyComponent={list?.ok ? (
        <Text variant="subhead" tone="secondary">Open Pane on another computer on your Tailscale login to see it here.</Text>
      ) : null}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingVertical: 16 },
  header: { gap: 12, marginBottom: 8 },
  row: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1, gap: 2 },
  password: { gap: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
