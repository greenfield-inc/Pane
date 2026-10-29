import { router } from 'expo-router';
import { useState } from 'react';

import { passwordProblem } from '@/auth/computers';
import { useConnectComputer } from '@/features/computers/useComputers';
import { Button, Sheet, Text, TextField } from '@/ui';

import { useMachines } from './useMachines';

/**
 * The password for a machine this phone never connected to, asked before its first connect. A
 * wrong one says so and leaves you on the current machine; the right one saves it and switches.
 */
export function ConnectMachineSheet({ machineKey }: { machineKey: string }) {
  const machine = useMachines().find(candidate => candidate.key === machineKey);
  const connect = useConnectComputer();
  const [password, setPassword] = useState('');
  const { tailnet, domain } = machine ?? {};
  const problem = passwordProblem(connect.error);
  const error = problem === 'invalid' ? 'That password is wrong.' : problem ? null : connect.error?.message;

  const submit = () => {
    if (!tailnet || !domain || !password) return;
    connect.mutate({ machine: tailnet, domain, password });
  };

  return (
    <Sheet
      testID="machine-connect-sheet"
      title={machine ? `Connect to ${machine.name}` : 'Connect'}
      footer={(
        <>
          <Button testID="machine-connect-submit" title="Connect" loading={connect.isPending} disabled={!password || !tailnet} onPress={submit} />
          <Button testID="machine-connect-cancel" title="Cancel" variant="plain" onPress={() => router.back()} />
        </>
      )}
    >
      <Text variant="subhead" tone="secondary">
        {machine ? `Enter the password set in Pane on ${machine.name}.` : 'This machine is no longer listed.'}
      </Text>
      <TextField
        testID="machine-connect-password"
        placeholder="Password"
        value={password}
        onChangeText={value => { setPassword(value); connect.reset(); }}
        secureTextEntry
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="go"
        onSubmitEditing={submit}
        error={error ?? undefined}
      />
    </Sheet>
  );
}
