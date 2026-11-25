import { useMutation } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Alert } from 'react-native';

import { parseRelayPairingLink, RelayPairingError } from '@shared/remoteClient';
import { fullAccessRefusal, readLinkPreview } from '@shared/remoteClient/relayLinkPreview';
import { DEVICE_ACCESS_LABELS, READ_ONLY_GRANT_HELP } from '@shared/types/accessLevel';

import { withCurrentAccess } from '@/auth/access';
import { useHostsStore } from '@/auth/hostsStore';
import { verifyConnectionCode } from '@/auth/pairing';
import { exchangeRelayLink, linkWithSavedComputers } from '@/auth/relayPairing';
import { streamingFetch } from '@/daemon/createClient';

/**
 * Pairs with a pairing QR's link (`https://<domain>/pair#…` or `pane://pair#…`) or a
 * pane-remote:// code, then saves it as the active host. A QR pairing also saves the computers
 * linked with it and links the new computer with this phone's others. A Read only link asks
 * first, unless `watchOnly` says the screen asked already; nothing is linked then, whatever the computer answers.
 * One to a computer this phone has full access to is refused without spending it.
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
      const before = useHostsStore.getState().profiles.map(withCurrentAccess);
      const preview = await readLinkPreview(streamingFetch, link);
      const refusal = fullAccessRefusal('phone', link.computerId, preview?.access, before);
      if (refusal) throw refusal;
      const watches = watchOnly || preview?.access === 'read';
      if (watches && !watchOnly && !(await confirmWatch(preview?.group[0]?.name ?? link.name))) {
        throw new RelayPairingError('Not paired', 'The code was not used.', 'cancelled', false);
      }
      const paired = await exchangeRelayLink(link, before, preview);
      const [computer, ...linked] = watches ? paired.map(profile => ({ ...profile, access: 'read' as const })) : paired;
      if (!computer) throw new Error('The computer sent no pairing.');
      // The preview said full, or couldn't be read.
      const late = fullAccessRefusal('phone', link.computerId, computer.access, before);
      if (late) throw late;
      onPaired?.();
      await addHosts(linked, computer);
      if (!watches) void linkWithSavedComputers(computer, linked, before).catch((error: unknown) => console.info('[relay] linking failed', error));
      return computer;
    },
    onSuccess: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    onError: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  });
}

/** Read only, said before the code is spent. */
function confirmWatch(name: string): Promise<boolean> {
  return new Promise(resolve => Alert.alert(`Watch ${name}`, `${DEVICE_ACCESS_LABELS.read}. ${READ_ONLY_GRANT_HELP}`, [
    { text: 'Not mine, cancel', style: 'cancel', onPress: () => resolve(false) },
    { text: `Pair ${DEVICE_ACCESS_LABELS.read}`, onPress: () => resolve(true) },
  ]));
}
