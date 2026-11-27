import { router } from 'expo-router';

import { SortApprovalsSheet } from '@/features/approvals/SortApprovalsSheet';
import { FocusScope } from '@/features/controller/FocusScope';

export default function SortApprovalsRoute() {
  return <FocusScope bare onBack={() => router.back()}><SortApprovalsSheet /></FocusScope>;
}
