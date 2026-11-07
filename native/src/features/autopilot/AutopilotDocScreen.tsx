import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { decisionModel } from '@shared/autopilotDecision';
import type { AutopilotDocument } from '@shared/types/autopilot';

import { useDaemon, useInvokeQuery } from '@/daemon';
import { browserPage } from '@/features/browser/browserPage';
import { usePorts } from '@/features/browser/usePorts';
import { ConnectionBar } from '@/features/hosts/ConnectionStatus';
import { useConnectionPresence } from '@/features/hosts/useConnectionPresence';
import { useNotifyShared } from '@/features/notify/hooks';
import { StateScreen } from '@/features/tabs/StateScreen';
import { monoFontFamily, useTheme } from '@/theme';
import { Button, ErrorState, Icon, Text } from '@/ui';

import { docBackLabel, fileName, autopilotItems } from './autopilot';
import { useAutopilot } from './hooks';

function backToItem() {
  if (router.canGoBack()) router.back();
  else router.replace('/autopilot');
}

/**
 * A related document full screen (D-76), with nothing to answer here: "‹ Q-14 · file name" on
 * top, the page or text, and "‹ Back to Q-14 to answer" at the bottom. An HTML file is read
 * through the phone's own connection (`autopilot:read-doc`); a page loads as the page tabs do.
 */
export function AutopilotDocScreen({ notifyId, path, url, label }: { notifyId?: string; path?: string; url?: string; label?: string }) {
  const theme = useTheme();
  const { colors } = theme;
  const insets = useSafeAreaInsets();
  const { notice, retry } = useConnectionPresence();
  const notify = useNotifyShared();
  const autopilot = useAutopilot();
  const item = autopilotItems(autopilot.data, notify.data?.items).find(candidate => candidate.id === notifyId);
  // A document with no item (Sentinel's away log) opens from the chat and goes back to it.
  const back = notifyId ? docBackLabel(item ? decisionModel(item) : undefined) : 'Chat';
  const footer = notifyId ? `Back to ${back} to answer` : 'Back to the chat';
  const name = path ? fileName(path) : label ?? url ?? '';
  return (
    <View testID="autopilot-doc-screen" style={[styles.fill, { backgroundColor: colors.surface }]}>
      <View style={{ paddingTop: insets.top, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }}>
        <View style={styles.bar}>
          <Pressable testID="autopilot-doc-back" accessibilityRole="button" accessibilityLabel={`Back to ${back}`} hitSlop={6} onPress={backToItem} style={styles.back}>
            <Icon ios="chevron.left" android="arrow_back" size={18} color={colors.text} />
            <Text variant="headline">{back}</Text>
          </Pressable>
          <Text variant="subhead" tone="muted" numberOfLines={1} style={styles.name}>{name}</Text>
          {url ? (
            <Pressable testID="autopilot-doc-external" accessibilityRole="link" accessibilityLabel="Open in the browser" hitSlop={6} onPress={() => void Linking.openURL(url)} style={styles.square}>
              <Icon ios="arrow.up.right.square" android="open_in_new" size={18} color={colors.textSecondary} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <ConnectionBar notice={notice} onRetry={retry} />
      <View style={styles.fill}>{path ? <FileDoc path={path} /> : url ? <UrlDoc url={url} /> : null}</View>
      <Pressable testID="autopilot-doc-return" accessibilityRole="button" accessibilityLabel={footer} onPress={backToItem}
        style={({ pressed }) => [styles.footer, { paddingBottom: insets.bottom + 12, borderTopColor: colors.border, backgroundColor: pressed ? colors.surfacePressed : colors.surface }]}>
        <Icon ios="chevron.left" android="chevron_left" size={13} color={colors.textMuted} />
        <Text variant="subhead" tone="muted">{footer}</Text>
      </Pressable>
    </View>
  );
}

function FileDoc({ path }: { path: string }) {
  const { colors } = useTheme();
  const { profile } = useDaemon();
  const doc = useInvokeQuery<AutopilotDocument>('autopilot:read-doc', [path, { inline: true }], { retry: false });
  if (doc.isPending) return <View style={styles.center}><ActivityIndicator /></View>;
  if (doc.isError) return <ErrorState title={`Couldn’t open ${fileName(path)}`} error={doc.error} onRetry={() => void doc.refetch()} testID="autopilot-doc-error" />;
  const read = doc.data;
  if (read.kind === 'missing') return <StateScreen testID="autopilot-doc-missing" icon={{ ios: 'doc.questionmark', android: 'draft' }} title={`Can’t open ${fileName(path)}`} message={read.message} />;
  if (read.kind === 'html') {
    // A computer from before the phone could read pages inline sends only its file URL.
    if (read.html === undefined) return <StateScreen testID="autopilot-doc-update" icon={{ ios: 'arrow.down.circle', android: 'system_update' }} title="Update Pane on the computer" message={`${profile.label}’s Pane is too old to send this page to the phone. Update it, or open the page in Pane there.`} />;
    return <WebView testID="autopilot-doc-page" originWhitelist={['*']} source={{ html: read.html }} style={[styles.fill, { backgroundColor: colors.surface }]} />;
  }
  return (
    <ScrollView testID="autopilot-doc-text" style={styles.fill} contentContainerStyle={styles.text}>
      <Text variant="footnote" selectable style={{ fontFamily: monoFontFamily, color: colors.text }}>{read.text}</Text>
    </ScrollView>
  );
}

/** A page: through the phone addresses the computer makes for its dev servers, or the address itself. */
function UrlDoc({ url }: { url: string }) {
  const page = browserPage(url, usePorts(), 'autopilot');
  if (page.kind === 'web') return <WebView testID="autopilot-doc-page" source={{ uri: page.src }} style={styles.fill} />;
  if (page.kind === 'loading') return <View style={styles.center}><ActivityIndicator /></View>;
  let message = 'The phone can’t load this page here.';
  if (page.kind === 'refused') message = `Nothing is listening on port ${page.port} on the computer right now.`;
  else if (page.kind === 'pages-off') message = page.reason;
  else if (page.kind === 'update') message = 'The computer’s Pane is too old to share its pages with the phone.';
  return <StateScreen testID="autopilot-doc-unavailable" icon={{ ios: 'globe', android: 'language' }} title={`Can’t open ${page.address || url}`} message={message}
    actions={/^https?:/i.test(url) ? <Button title="Open in the browser" variant="secondary" onPress={() => void Linking.openURL(url)} /> : undefined} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bar: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingRight: 8 },
  name: { flex: 1, textAlign: 'right' },
  square: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  text: { padding: 16 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
