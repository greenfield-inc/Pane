import { useMutation } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Alert } from 'react-native';

import { parseRelayPairingLink } from '@shared/remoteClient';
import { DEVICE_ACCESS_LABELS } from '@shared/types/accessLevel';

import { isReadOnlyProfile } from '@/auth/access';
import { useHostsStore } from '@/auth/hostsStore';
import { verifyConnectionCode } from '@/auth/pairing';
import { exchangeRelayLink, linkWithSavedComputers } from '@/auth/relayPairing';

/**
 * Pairs with a pairing QR's link (`https://<domain>/pair#…` or `pane://pair#…`) or a
 * pane-remote:// code, then saves it as the active host. A QR pairing also saves the computers
 * linked with it and links the new computer with this phone's others. A Read only pairing says so.
 * `watchOnly`: the person confirmed a Read only link, so nothing is linked even if the computer answers otherwise.
 */
export function usePairing(onPaired?: () => void) {
  const addHost = useHostsStore(state => state.add);
  const addHosts = useHostsStore(state => state.addMany);
  return useMutation({
    mutationFn: async ({ code, watchOnly = false }: { code: string; watchOnly?: boolean }) => {
      const link = parseRelayPairingLink(code);
      if (!link) {
        const profile = await verifyConnectionCode(code);
        onPaired?.();
        await addHost(profile);
        return profile;
      }
      const before = useHostsStore.getState().profiles;
      const [computer, ...linked] = await exchangeRelayLink(link, before);
      if (!computer) throw new Error('The computer sent no pairing.');
      onPaired?.();
      await addHosts(linked, computer);
      if (!watchOnly) void linkWithSavedComputers(computer, linked, before).catch((error: unknown) => console.info('[relay] linking failed', error));
      return computer;
    },
    onSuccess: computer => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (isReadOnlyProfile(computer)) {
        Alert.alert(`${computer.label}: ${DEVICE_ACCESS_LABELS.read}`, `This phone sees ${computer.label}’s Sessions, agents, transcripts and terminal output. It can’t type, run, approve, open files or see its keys.`);
      }
    },
    onError: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  });
}
