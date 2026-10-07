import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { directoryProfile, parseComputerAddress } from '@/auth/computers';
import { useActiveHost, useHostsStore } from '@/auth/hostsStore';
import { Button, TextField } from '@/ui';

import { ComputerList } from './ComputerList';

/**
 * "Your computers": every computer on your Tailscale login with Pane open, one tap to connect.
 * The list comes from a computer this phone already knows; the first time, from the address you
 * type in, as shown in Pane on that computer.
 */
export function ComputersScreen({ onConnected }: { onConnected?: () => void }) {
  const active = useActiveHost();
  const profiles = useHostsStore(state => state.profiles);
  const known = active?.tailnetMachine ? active : profiles.find(profile => profile.tailnetMachine) ?? null;
  const [typed, setTyped] = useState<RemotePaneConnectionProfile | null>(null);
  const directory = typed ?? known;

  return (
    <ComputerList
      directory={directory}
      onConnected={onConnected}
      header={directory ? undefined : <FindComputersForm onFind={setTyped} />}
    />
  );
}

function FindComputersForm({ onFind }: { onFind: (directory: RemotePaneConnectionProfile) => void }) {
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const find = () => {
    const parsed = parseComputerAddress(address);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onFind(directoryProfile(parsed));
  };

  return (
    <View style={styles.form}>
      <TextField
        testID="computers-address"
        label="Computer address"
        placeholder="studio-mac.tail1234.ts.net"
        hint="In Pane on that computer: Settings › Remote Access › Address."
        error={error}
        value={address}
        onChangeText={setAddress}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="search"
        onSubmitEditing={find}
      />
      <Button testID="computers-find" title="Find Computers" onPress={find} />
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 12, marginBottom: 8 },
});
