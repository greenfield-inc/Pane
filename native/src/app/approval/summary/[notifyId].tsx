import { useLocalSearchParams } from 'expo-router';

import { ApprovalSummaryScreen } from '@/features/approvals/ApprovalSummaryScreen';

/** An approval's Summary page, read from the machine the phone is on. */
export default function ApprovalSummaryRoute() {
  const { notifyId } = useLocalSearchParams<{ notifyId: string }>();
  return <ApprovalSummaryScreen notifyId={notifyId} />;
}
