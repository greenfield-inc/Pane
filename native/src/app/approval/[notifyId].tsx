import { useLocalSearchParams } from 'expo-router';

import { useDaemon } from '@/daemon';

import { parseApprovalList } from '@/features/approvals/approvals';
import { ApprovalScreen } from '@/features/approvals/ApprovalScreen';
import { useShowsWaiting } from '@/features/home/seenStore';

/** One approval as the first tab before its Session's (or asking Pane's); `paneId` is the Pane a push alert named, `list` the one of Approvals' lists it was opened from. */
export default function ApprovalRoute() {
  const { notifyId, paneId, list } = useLocalSearchParams<{ notifyId: string; paneId?: string; list?: string }>();
  const { profile } = useDaemon();
  useShowsWaiting({ machineKey: profile.id, key: `${profile.id}:question:${notifyId}` });
  return <ApprovalScreen notifyId={notifyId} hintPaneId={paneId} list={parseApprovalList(list)} />;
}
