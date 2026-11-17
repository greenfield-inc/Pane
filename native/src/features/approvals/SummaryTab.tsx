import { ActivityIndicator, StyleSheet, View } from 'react-native';

import type { NotifySummaryPage } from '@shared/types/notify';

import { useInvokeQuery } from '@/daemon';
import { StateScreen } from '@/features/tabs/StateScreen';
import { useTheme } from '@/theme';
import { ErrorState } from '@/ui';

import { StaticPage } from './StaticPage';

/**
 * An approval's Summary tab (P4): the asker's own page, or the one Pane writes from the card, read
 * through the phone's connection (`notify:summary-page`) in the phone's light or dark. Its html
 * carries a CSP with no scripts or network, and it draws as a `StaticPage`.
 * `notifyId` is the id on the machine the phone is on.
 */
export function SummaryTab({ notifyId }: { notifyId: string }) {
  const theme = useTheme();
  const page = useInvokeQuery<NotifySummaryPage>('notify:summary-page', [notifyId, { theme: theme.scheme }], { retry: false });
  if (page.isPending) return <View style={styles.center}><ActivityIndicator /></View>;
  if (page.isError) return <ErrorState title="Couldn’t open the Summary" error={page.error} onRetry={() => void page.refetch()} testID="approval-summary-error" />;
  if (page.data.kind === 'missing') return <StateScreen testID="approval-summary-missing" icon={{ ios: 'doc.questionmark', android: 'draft' }} title="No Summary to show" message={page.data.message} />;
  return <StaticPage testID="approval-summary-page" html={page.data.html} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
