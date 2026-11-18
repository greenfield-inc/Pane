// Dictation through Glassly's own speech-to-text, for a computer with no speech key or one that
// can't take the glasses' live socket (an older Pane). The words go to Glassly Cloud and count
// against the wearer's Glassly plan minutes.
import type { Dictation } from '../../../src/model';
import type { Cancel } from '../../../src/platform';

export interface Heard {
  text: string;
  isFinal: boolean;
}

/** Time for the last words to arrive after the person lets go. */
const FINAL_WAIT_MS = 800;

export function glasslyDictation(
  listen: (onHeard: (heard: Heard) => void) => () => void,
  later: (fn: () => void, ms: number) => Cancel,
  onPreview: (text: string) => void,
): Dictation {
  const finals: string[] = [];
  let interim = '';
  const words = () => [...finals, interim].filter(Boolean).join(' ').trim();
  let stop: (() => void) | null = listen((heard) => {
    if (heard.isFinal) {
      if (heard.text.trim()) finals.push(heard.text.trim());
      interim = '';
    } else interim = heard.text.trim();
    onPreview(words());
  });
  const end = () => {
    stop?.();
    stop = null;
  };
  onPreview('Listening (Glassly speech-to-text)…');
  return {
    push() {
      // Glassly listens to the glasses' mic itself.
    },
    async finish() {
      await new Promise<void>((resolve) => { later(resolve, FINAL_WAIT_MS); });
      end();
      return words();
    },
    cancel: end,
  };
}
