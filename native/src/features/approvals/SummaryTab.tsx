import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';

import type { NotifySummaryPage } from '@shared/types/notify';

import { useInvokeQuery } from '@/daemon';
import { StateScreen } from '@/features/tabs/StateScreen';
import { useTheme } from '@/theme';
import { ErrorState, SkeletonSwap } from '@/ui';

import { PageSkeleton, StaticPage } from '@/features/pages/StaticPage';

/**
 * An approval's Summary tab (P4): the asker's own page, or the one Pane writes from the card, read
 * through the phone's connection (`notify:summary-page`) in the phone's light or dark. Its html
 * carries a CSP with no scripts or network, and it draws as a `StaticPage`.
 * `notifyId` is the id on the machine the phone is on.
 */
export function SummaryTab({ notifyId }: { notifyId: string }) {
  const theme = useTheme();
  const page = useInvokeQuery<NotifySummaryPage>('notify:summary-page', [notifyId, { theme: theme.scheme }], { retry: false });
  let content: ReactNode = null;
  if (page.isError) content = <ErrorState title="Couldn’t open the Summary" error={page.error} onRetry={() => void page.refetch()} testID="approval-summary-error" />;
  else if (page.data?.kind === 'missing') content = <StateScreen testID="approval-summary-missing" icon={{ ios: 'doc.questionmark', android: 'draft' }} title="No Summary to show" message={page.data.message} />;
  else if (page.data) content = <StaticPage testID="approval-summary-page" html={page.data.html} />;
  return <SkeletonSwap loading={page.isPending} skeleton={<PageSkeleton testID="approval-summary-skeleton" label="Loading the Summary" />} style={styles.fill}>{content}</SkeletonSwap>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
