import type { RefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { useTheme } from '@/theme';

import { terminalHtml } from './terminalHtml.generated';

export interface TerminalWebViewProps {
  ref: RefObject<WebView | null>;
  onMessage: (event: WebViewMessageEvent) => void;
  /** The rows on screen, read out by screen readers. */
  screenText: string;
  /** iOS or Android reclaimed the page's process; the page needs loading again. */
  onProcessGone: () => void;
}

/** The xterm page. It is self-contained: no network, no navigation, no touch. */
export function TerminalWebView({ ref, onMessage, screenText, onProcessGone }: TerminalWebViewProps) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel="Terminal"
      accessibilityValue={{ text: screenText }}
      testID="terminal-screen"
      style={styles.fill}
    >
      <WebView
        ref={ref}
        testID="terminal-webview"
        source={{ html: terminalHtml }}
        originWhitelist={['about:*']}
        onShouldStartLoadWithRequest={request => request.url.startsWith('about:')}
        onMessage={onMessage}
        onContentProcessDidTerminate={onProcessGone}
        onRenderProcessGone={onProcessGone}
        style={[styles.fill, { backgroundColor: theme.terminal.background }]}
        containerStyle={{ backgroundColor: theme.terminal.background }}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        hideKeyboardAccessoryView
        keyboardDisplayRequiresUserAction
        allowsLinkPreview={false}
        textInteractionEnabled={false}
        setBuiltInZoomControls={false}
        webviewDebuggingEnabled={__DEV__}
      />
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
