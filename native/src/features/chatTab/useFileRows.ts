import { useEffect, useRef, useState } from 'react';

import { FILE_SEARCH_DELAY_MS, type ComposerTrigger } from '@shared/composerMentions';
import type { ChatTabClient, ChatTabFile } from '@shared/types/chatTab';

/** An @ menu's files: none yet, the newest answer, or that the computer could not list them. */
export type FileRows = { state: 'searching' } | { state: 'failed' } | { state: 'ready'; files: readonly ChatTabFile[] };

/**
 * The host's files for an open @ trigger. A menu that opens asks at once; each key after waits 120 ms.
 * The last answer stays on screen until the next one arrives.
 */
export function useFileRows(chat: ChatTabClient, panelId: string, trigger: ComposerTrigger | null): FileRows {
  const open = trigger?.kind === 'file' ? trigger : null;
  const word = open ? open.rangeStart : null;
  const query = open?.query ?? '';
  const [answer, setAnswer] = useState<{ word: number; rows: FileRows } | null>(null);
  const searched = useRef<number | null>(null);
  useEffect(() => {
    if (word === null) { searched.current = null; return; }
    let current = true;
    const delay = searched.current === word ? FILE_SEARCH_DELAY_MS : 0;
    searched.current = word;
    const timer = setTimeout(() => {
      chat.files(panelId, query).then(
        files => { if (current) setAnswer({ word, rows: { state: 'ready', files } }); },
        () => { if (current) setAnswer({ word, rows: { state: 'failed' } }); },
      );
    }, delay);
    return () => { current = false; clearTimeout(timer); };
  }, [chat, panelId, word, query]);
  // An answer for a word that closed is dropped, so reopening starts from "Searching files…".
  useEffect(() => { if (word === null) setAnswer(null); }, [word]);
  return answer && answer.word === word ? answer.rows : { state: 'searching' };
}
