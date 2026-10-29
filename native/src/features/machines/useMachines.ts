import { router } from 'expo-router';
import { Alert } from 'react-native';

import { passwordProblem } from '@/auth/computers';
import { useHostsStore } from '@/auth/hostsStore';
import { useDaemon } from '@/daemon';
import { useComputers, useConnectComputer } from '@/features/computers/useComputers';
import { useConnectionPresence } from '@/features/hosts/useConnectionPresence';

import { listMachines, type Machine } from './machines';

/**
 * Every machine this phone can switch to: the saved ones, plus your own Tailscale machines it has
 * never connected to. The Tailscale list comes from the current machine, or any saved one on
 * Tailscale, and refreshes every 30 s while a screen shows it. A phone paired only by code has no
 * list to read, so it sees its saved machines alone.
 */
export function useMachines(): Machine[] {
  const { profile, connection } = useDaemon();
  const profiles = useHostsStore(state => state.profiles);
  const directory = profile.tailnetMachine ? profile : profiles.find(saved => saved.tailnetMachine) ?? null;
  const computers = useComputers(directory);
  const { presence } = useConnectionPresence();
  return listMachines({ profiles, current: profile, connection: connection.status, presence, tailnet: computers.data });
}

/**
 * After a new machine connects it is saved under a new key, so screens opened for its Tailscale entry
 * (Machine details, the password sheet) no longer match anything: go back to home.
 */
export function closeToHome() {
  if (router.canDismiss()) router.dismissAll();
}

/**
 * One tap on a machine: a saved one becomes current, which remounts every screen for it; a new
 * one connects the way "Your computers" does and is saved, asking for its password first when it
 * needs one. A failed connect leaves you on the current machine.
 */
export function useSelectMachine() {
  const setActive = useHostsStore(state => state.setActive);
  const connect = useConnectComputer(closeToHome);

  const askPassword = (machine: Machine) => router.push({ pathname: '/machine/connect', params: { key: machine.key } });

  const select = (machine: Machine) => {
    if (!machine.selectable || connect.isPending) return;
    if (machine.profile) {
      void setActive(machine.profile.id);
      return;
    }
    const { tailnet, domain } = machine;
    if (!tailnet || !domain) return;
    if (tailnet.state === 'password-required') {
      askPassword(machine);
      return;
    }
    connect.mutate({ machine: tailnet, domain }, {
      onError: error => (passwordProblem(error) ? askPassword(machine) : Alert.alert(`Couldn’t connect to ${machine.name}`, error.message)),
    });
  };

  return { select, connecting: connect.isPending ? connect.variables.machine.name : null };
}
