import { useMutation } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';

import { useHostsStore } from '@/auth/hostsStore';
import { verifyConnectionCode } from '@/auth/pairing';

/** Verifies a pane-remote:// code against its host, then saves it as the active host. */
export function usePairing(onPaired?: () => void) {
  const addHost = useHostsStore(state => state.add);
  return useMutation({
    mutationFn: async (code: string) => {
      const profile = await verifyConnectionCode(code);
      onPaired?.();
      await addHost(profile);
      return profile;
    },
    onSuccess: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    onError: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  });
}
