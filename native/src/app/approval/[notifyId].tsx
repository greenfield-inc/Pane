import { useLocalSearchParams } from 'expo-router';

import { ApprovalScreen } from '@/features/approvals/ApprovalScreen';

/** One approval above its Session (or asking Pane); `paneId` is the Pane a push alert named. */
export default function ApprovalRoute() {
  const { notifyId, paneId } = useLocalSearchParams<{ notifyId: string; paneId?: string; panelId?: string }>();
  return <ApprovalScreen notifyId={notifyId} hintPaneId={paneId} />;
}
