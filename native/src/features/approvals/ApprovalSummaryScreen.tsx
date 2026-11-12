import { router } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import type { NotifySummaryPage } from '@shared/types/notify';

import { useInvokeQuery } from '@/daemon';
import { ConnectionBar } from '@/features/hosts/ConnectionStatus';
import { useConnectionPresence } from '@/features/hosts/useConnectionPresence';
import { useNotifyShared } from '@/features/notify/hooks';
import { StateScreen } from '@/features/tabs/StateScreen';
import { useTheme } from '@/theme';
import { ErrorState, Icon, Text } from '@/ui';

import { summaryLoadAllowed } from './approvals';

/** Opens approval `notifyId`'s Summary above its card. `notifyId` is the id on the machine the phone is on. */
export function openApprovalSummary(notifyId: string) {
  router.push({ pathname: '/approval/summary/[notifyId]', params: { notifyId } });
}

function back() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/**
 * An approval's Summary (P4): the asker's own page, or the one Pane writes from the card, read
 * through the phone's connection (`notify:summary-page`) in the phone's light or dark. The page
 * renders with scripts off and goes nowhere: its html carries a CSP with no scripts or network,
 * and the WebView also turns JavaScript off, injects nothing and refuses every navigation.
 */
export function ApprovalSummaryScreen({ notifyId }: { notifyId: string }) {
  const theme = useTheme();
  const { colors } = theme;
  const insets = useSafeAreaInsets();
  const { notice, retry } = useConnectionPresence();
  const title = useNotifyShared().data?.items.find(item => item.id === notifyId)?.title;
  const page = useInvokeQuery<NotifySummaryPage>('notify:summary-page', [notifyId, { theme: theme.scheme }], { retry: false });

  let body;
  if (page.isPending) {
    body = <View style={styles.center}><ActivityIndicator /></View>;
  } else if (page.isError) {
    body = <ErrorState title="Couldn’t open the Summary" error={page.error} onRetry={() => void page.refetch()} testID="approval-summary-error" />;
  } else if (page.data.kind === 'missing') {
    body = <StateScreen testID="approval-summary-missing" icon={{ ios: 'doc.questionmark', android: 'draft' }} title="No Summary to show" message={page.data.message} />;
  } else {
    body = (
      <WebView
        testID="approval-summary-page"
        source={{ html: page.data.html }}
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

  return (
    <View testID="approval-summary-screen" style={[styles.fill, { backgroundColor: colors.surface }]}>
      <View style={{ paddingTop: insets.top, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }}>
        <View style={styles.bar}>
          <Pressable testID="approval-summary-back" accessibilityRole="button" accessibilityLabel="Back to the approval" hitSlop={6} onPress={back} style={styles.back}>
            <Icon ios="chevron.left" android="arrow_back" size={18} color={colors.text} />
            <Text variant="headline">Summary</Text>
          </Pressable>
          {title ? <Text variant="subhead" tone="muted" numberOfLines={1} style={styles.name}>{title}</Text> : null}
        </View>
      </View>
      <ConnectionBar notice={notice} onRetry={retry} />
      <View style={[styles.fill, { paddingBottom: insets.bottom }]}>{body}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bar: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingRight: 8 },
  name: { flex: 1, textAlign: 'right' },
});
