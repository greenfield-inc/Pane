import { useLocalSearchParams } from 'expo-router';

import { parseApprovalList } from '@/features/approvals/approvals';
import { ApprovalScreen } from '@/features/approvals/ApprovalScreen';

/** One approval above its Session (or asking Pane); `paneId` is the Pane a push alert named, `list` the one of Approvals' lists it was opened from. */
export default function ApprovalRoute() {
  const { notifyId, paneId, list } = useLocalSearchParams<{ notifyId: string; paneId?: string; panelId?: string; list?: string }>();
  return <ApprovalScreen notifyId={notifyId} hintPaneId={paneId} list={parseApprovalList(list)} />;
}
