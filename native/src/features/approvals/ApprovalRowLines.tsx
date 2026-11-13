import type { NotifyItem } from '@shared/types/notify';

import { replyStateLine, type ReplyTone } from '@/features/notify/notifyQuestions';
import { useTheme } from '@/theme';
import { Text } from '@/ui';

import { questionSubtitle } from './approvals';

/** What a question's row says beyond its title, for screen readers: its subtitle and reply status. */
export function approvalRowSpoken(item: NotifyItem): string[] {
  return [questionSubtitle(item), replyStateLine(item)?.text].filter(line => line !== undefined);
}

/**
 * Under a question's row on home: the card's subtitle (its context, two lines at most) and,
 * after the person replied, where the reply stands ("okta-sso-account is reading your reply").
 */
export function ApprovalRowLines({ item, testID }: { item: NotifyItem; testID: string }) {
  const theme = useTheme();
  const subtitle = questionSubtitle(item);
  const status = replyStateLine(item);
  const color: Record<ReplyTone, string> = { success: theme.colors.success, warning: theme.colors.warning, accent: theme.colors.accentText, muted: theme.colors.textSecondary };
  return (
    <>
      {subtitle ? <Text testID={`${testID}-subtitle`} variant="footnote" tone="secondary" numberOfLines={2}>{subtitle}</Text> : null}
      {status ? <Text testID={`${testID}-status`} variant="footnote" numberOfLines={1} style={{ color: color[status.tone] }}>{status.text}</Text> : null}
    </>
  );
}
