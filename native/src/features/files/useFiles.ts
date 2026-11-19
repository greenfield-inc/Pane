import { useQuery } from '@tanstack/react-query';

import { useDaemon, useDaemonQueryKey } from '@/daemon';

import { decodeBinary, decodeFileText, decodeFolder, decodeSearch } from './files';

// The file channels answer `{ success, files | content | contentBase64 }` rather than the
// `{ success, data }` envelope `useInvokeQuery` unwraps, so these read the answer whole.
function useFileQuery<T>(channel: string, request: object, decode: (response: unknown) => T, enabled = true) {
  const { client } = useDaemon();
  const queryKey = useDaemonQueryKey(channel, [request]);
  return useQuery({ queryKey, enabled, queryFn: async () => decode(await client.invoke(channel, [request])) });
}

export const useFolder = (sessionId: string, path: string, enabled?: boolean) =>
  useFileQuery('file:list', { sessionId, path }, decodeFolder, enabled);

export const useFileText = (sessionId: string, filePath: string, enabled: boolean) =>
  useFileQuery('file:read', { sessionId, filePath }, decodeFileText, enabled);

export const useFileBinary = (sessionId: string, filePath: string, enabled: boolean) =>
  useFileQuery('file:read-binary', { sessionId, filePath }, decodeBinary, enabled);

export const useFileSearch = (sessionId: string, pattern: string) =>
  useFileQuery('file:search', { sessionId, pattern, limit: 200 }, decodeSearch, pattern.length > 0);
