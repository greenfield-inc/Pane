import { useEffect, useState } from 'react';
import { FILE_SEARCH_DELAY_MS } from '../../../../shared/composerMentions';
import type { ChatTabClient, ChatTabFile } from '../../../../shared/types/chatTab';

export interface FileSearch { rows: ChatTabFile[]; status: 'searching' | 'ready' | 'failed'; /** What the rows answer. */ query: string }

const SEARCHING: FileSearch = { rows: [], status: 'searching', query: '' };

/**
 * The @ menu's files from the host. A menu that just opened searches at once; typing waits for
 * the last key. Earlier rows stay until the newer ones arrive. `query` is undefined while closed.
 */
export function useFileSearch(client: ChatTabClient, panelId: string, query: string | undefined): FileSearch {
  const open = query !== undefined;
  const [search, setSearch] = useState(SEARCHING);
  const [typed, setTyped] = useState(false);
  useEffect(() => {
    if (open) return undefined;
    setSearch(SEARCHING);
    setTyped(false);
    return undefined;
  }, [open]);
  useEffect(() => {
    if (query === undefined) return undefined;
    let current = true;
    const run = () => {
      setTyped(true);
      client.files(panelId, query).then(
        rows => { if (current) setSearch({ rows, status: 'ready', query }); },
        error => {
          console.warn('[ChatTabs] File search failed:', error);
          if (current) setSearch({ rows: [], status: 'failed', query });
        },
      );
    };
    setSearch(previous => previous.status === 'ready' && previous.rows.length ? previous : SEARCHING);
    const timer = setTimeout(run, typed ? FILE_SEARCH_DELAY_MS : 0);
    return () => { current = false; clearTimeout(timer); };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `typed` only says whether the next search waits.
  }, [client, panelId, query]);
  return search;
}
