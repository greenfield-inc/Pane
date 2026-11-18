import { useLocalSearchParams } from 'expo-router';

import { parseApprovalList } from '@/features/approvals/approvals';
import { ApprovalScreen } from '@/features/approvals/ApprovalScreen';

/** One approval as the first tab before its Session's (or asking Pane's); `paneId` is the Pane a push alert named, `list` the one of Approvals' lists it was opened from. */
export default function ApprovalRoute() {
  const { notifyId, paneId, list } = useLocalSearchParams<{ notifyId: string; paneId?: string; list?: string }>();
  return <ApprovalScreen notifyId={notifyId} hintPaneId={paneId} list={parseApprovalList(list)} />;
}
