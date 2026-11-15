import { router } from 'expo-router';

import { PairingCamera } from '@/features/pairing/PairingCamera';
import { Button } from '@/ui';

/** Scans a pairing QR or a pane-remote:// code, from Settings or the connection form. */
export default function ScanScreen() {
  return (
    <PairingCamera
      caption="Scan the code in Pane on your computer"
      // Close the scanner and any "Add a computer" screen under it.
      onPaired={() => router.dismissAll()}
      actions={<Button testID="scan-back" title="Cancel" variant="secondary" onPress={() => router.back()} />}
    />
  );
}
