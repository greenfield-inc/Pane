import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { DiffScope, FileDiffRequest } from '@shared/types/gitDiff';

import { useDaemon, useDaemonEvent, useDaemonQueryKey } from '@/daemon';

import { decodeFileDiff, decodeManifest } from './diff';

/** The branch's changes, as the desktop's Changes panel shows them by default. */
export const BRANCH_SCOPE: DiffScope = { kind: 'session' };
/** A list fetched for Explorer serves the Diff tab too, and the other way round, for this long. */
const MANIFEST_FRESH_MS = 30_000;

/**
 * The branch's changed files, fetched when Explorer or Diff opens and shared between them. A
 * refused or failed read (an older computer, an archived Pane) is an error, never a retry loop.
 */
export function useChanges(sessionId: string) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const queryKey = useDaemonQueryKey('sessions:get-diff-manifest', [sessionId, BRANCH_SCOPE]);
  // The computer re-reads git status after its files change; the list follows.
  useDaemonEvent('git-status-updated', event => {
    const payload = event.args[0] as { sessionId?: string } | undefined;
    if (payload?.sessionId === sessionId) void queryClient.invalidateQueries({ queryKey });
  });
  return useQuery({
    queryKey,
    staleTime: MANIFEST_FRESH_MS,
    retry: false,
    queryFn: async () => decodeManifest(await client.invoke('sessions:get-diff-manifest', [sessionId, BRANCH_SCOPE])),
  });
}

export function useFileDiff(sessionId: string, scope: DiffScope, request: FileDiffRequest, enabled = true) {
  const { client } = useDaemon();
  const queryKey = useDaemonQueryKey('sessions:get-file-diff', [sessionId, scope, request]);
  return useQuery({
    queryKey,
    enabled,
    retry: false,
    queryFn: async () => decodeFileDiff(await client.invoke('sessions:get-file-diff', [sessionId, scope, request])),
  });
}
