import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { terminalHtml } from './terminalHtml.generated';

/** Long enough for a cold launch to finish painting Home first. */
const PREWARM_AFTER_MS = 2_000;

/**
 * Loads the terminal page once, out of sight, a moment after launch, and keeps it loaded. The
 * system's web process then stays up, so a terminal opened later starts its page sooner.
 */
export function TerminalPrewarm() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), PREWARM_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!mounted) return null;
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.hidden}>
      <WebView source={{ html: terminalHtml }} originWhitelist={['about:*']} onShouldStartLoadWithRequest={request => request.url.startsWith('about:')} />
    </View>
  );
}

const styles = StyleSheet.create({ hidden: { position: 'absolute', width: 1, height: 1, opacity: 0, left: -10, top: -10 } });
