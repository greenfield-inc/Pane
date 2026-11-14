import { useMutation } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';

import { parseRelayPairingLink } from '@shared/remoteClient';

import { useHostsStore } from '@/auth/hostsStore';
import { verifyConnectionCode } from '@/auth/pairing';
import { exchangeRelayLink, linkWithSavedComputers } from '@/auth/relayPairing';

/**
 * Pairs with a pairing QR's link (`https://<domain>/pair#…` or `pane://pair#…`) or a
 * pane-remote:// code, then saves it as the active host. A QR pairing also saves the computers
 * linked with it and links the new computer with this phone's others.
 */
export function usePairing(onPaired?: () => void) {
  const addHost = useHostsStore(state => state.add);
  const addHosts = useHostsStore(state => state.addMany);
  return useMutation({
    mutationFn: async (code: string) => {
      const link = parseRelayPairingLink(code);
      if (!link) {
        const profile = await verifyConnectionCode(code);
        onPaired?.();
        await addHost(profile);
        return profile;
      }
      const [computer, ...linked] = await exchangeRelayLink(link);
      if (!computer) throw new Error('The computer sent no pairing.');
      const before = useHostsStore.getState().profiles;
      onPaired?.();
      await addHosts(linked, computer);
      void linkWithSavedComputers(computer, linked, before).catch((error: unknown) => console.info('[relay] linking failed', error));
      return computer;
    },
    onSuccess: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    onError: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  });
}
