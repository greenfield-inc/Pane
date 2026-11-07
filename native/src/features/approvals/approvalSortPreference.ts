import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import { parseApprovalSort, type ApprovalSort } from './approvals';

const SORT_KEY = 'approvals.sort';

function savedSort(): ApprovalSort {
  try {
    return parseApprovalSort(SecureStore.getItem(SORT_KEY));
  } catch {
    return 'recent';
  }
}

interface ApprovalSortState {
  sort: ApprovalSort;
  setSort(sort: ApprovalSort): void;
}

/** How Approvals lists, remembered on this device (expo-secure-store, read synchronously so the first frame already has it). */
export const useApprovalSort = create<ApprovalSortState>(set => ({
  sort: savedSort(),
  setSort: sort => {
    set({ sort });
    void SecureStore.setItemAsync(SORT_KEY, sort).catch(() => undefined);
  },
}));
