import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

import { useTheme } from '@/theme';

import { summaryLoadAllowed } from './approvals';

/**
 * An html page drawn as it is, with scripts off and going nowhere: the WebView turns JavaScript
 * off, injects nothing and refuses every navigation. The Summary and an approval's linked pages use it.
 */
export function StaticPage({ html, testID }: { html: string; testID: string }) {
  const { colors } = useTheme();
  return (
    <WebView
      testID={testID}
      source={{ html }}
      // Every URL reaches onShouldStartLoadWithRequest, which refuses all but the page itself. A
      // narrower list would hand the URLs it doesn't match to the phone to open (react-native-webview).
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={request => summaryLoadAllowed(request.url)}
      javaScriptEnabled={false}
      javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows={false}
      allowFileAccess={false}
      allowsLinkPreview={false}
      dataDetectorTypes="none"
      cacheEnabled={false}
      style={[styles.fill, { backgroundColor: colors.surface }]}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
});
