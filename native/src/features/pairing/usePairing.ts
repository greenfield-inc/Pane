import { useMutation } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Alert } from 'react-native';

import { parseRelayPairingLink, RelayPairingError, type RelayPairingLink } from '@shared/remoteClient';
import { fullAccessRefusal, readLinkPreview, type LinkPreviewAnswer } from '@shared/remoteClient/relayLinkPreview';
import { DEVICE_ACCESS_LABELS, READ_ONLY_GRANT_HELP, tokenAccess } from '@shared/types/accessLevel';

import { useHostsStore } from '@/auth/hostsStore';
import { verifyConnectionCode } from '@/auth/pairing';
import { exchangeRelayLink, linkWithSavedComputers } from '@/auth/relayPairing';
import { streamingFetch } from '@/daemon/createClient';

/**
 * Pairs with a pairing QR's link (`https://<domain>/pair#…` or `pane://pair#…`) or a
 * pane-remote:// code, then saves it as the active host. A QR pairing also saves the computers
 * linked with it and links the new computer with this phone's others. A Read only link asks
 * first, unless `preview` says what the screen read and the person agreed to; a computer that then answers with
 * another level pairs and links nothing.
 * One to a computer this phone has full access to is refused without spending it.
 */
export function usePairing(onPaired?: () => void) {
  const addHost = useHostsStore(state => state.add);
  const addHosts = useHostsStore(state => state.addMany);
  return useMutation({
    mutationFn: async ({ code, preview: agreed }: { code: string; preview?: LinkPreviewAnswer }) => {
      const link = parseRelayPairingLink(code);
      if (!link) {
        if (!code.trim().startsWith('pane-remote://')) throw new Error('Paste a pairing link (https://runpane.net/pair#…) or a connection code that starts with pane-remote://');
        const profile = await verifyConnectionCode(code);
        onPaired?.();
        await addHost(profile);
        return profile;
      }
      const before = useHostsStore.getState().profiles;
      const preview = agreed === undefined ? await previewLink(link) : agreed;
      const refusal = fullAccessRefusal('phone', [link.computerId, ...(preview?.group.map(computer => computer.id) ?? [])], preview?.access, before);
      if (refusal) throw refusal;
      if (agreed === undefined && preview?.access === 'read' && !(await confirmWatch(preview.group[0]?.name ?? link.name))) {
        throw new RelayPairingError('Not paired', 'The code was not used.', 'cancelled', false);
      }
      const [computer, ...linked] = await exchangeRelayLink(link, before, preview);
      if (!computer) throw new Error('The computer sent no pairing.');
      // The preview said full, or couldn't be read.
      const late = fullAccessRefusal('phone', [link.computerId, ...(preview?.group.map(member => member.id) ?? [])], tokenAccess(computer.token), before);
      if (late) throw late;
      onPaired?.();
      await addHosts(linked, computer);
      void linkWithSavedComputers(computer, linked, before).catch((error: unknown) => console.info('[relay] linking failed', error));
      return computer;
    },
    onSuccess: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    onError: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  });
}

/** The preview's own 10 s wait, less a timer's rounding. */
const PREVIEW_TIMEOUT_MS = 9_900;

/** What a link pairs, read without spending it. A computer that takes the whole wait is out of reach, so the exchange isn't tried too. */
export async function previewLink(link: RelayPairingLink): Promise<LinkPreviewAnswer> {
  const started = Date.now();
  const preview = await readLinkPreview(streamingFetch, link);
  if (!preview && Date.now() - started >= PREVIEW_TIMEOUT_MS) {
    throw new RelayPairingError(`Can’t reach ${link.name}`, `${link.name} didn’t answer, so the code was not used. Check that this phone is online and Pane is open on ${link.name}, then try again.`, 'unreachable', false);
  }
  return preview;
}

/** Read only, said before the code is spent. */
function confirmWatch(name: string): Promise<boolean> {
  return new Promise(resolve => Alert.alert(`Watch ${name}`, `${DEVICE_ACCESS_LABELS.read}. ${READ_ONLY_GRANT_HELP}`, [
    { text: 'Not mine, cancel', style: 'cancel', onPress: () => resolve(false) },
    { text: `Pair ${DEVICE_ACCESS_LABELS.read}`, onPress: () => resolve(true) },
  ]));
}
