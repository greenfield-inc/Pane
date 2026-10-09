import type { IDisposable } from '@xterm/xterm';

/**
 * Who gets to answer when an agent asks its terminal a question.
 *
 * Terminal queries — cursor position (`CSI 6 n`), device attributes (`CSI c`),
 * version, window and cell size, mode state — are asked of *the* terminal, and
 * the agent expects exactly one reply. Pane can have several renderers on one
 * PTY: the session's terminal panel and any Mission Control tile showing the
 * same agent. Two answers are worse than none. Codex places its inline
 * viewport from the cursor-position report, so a second, differently-positioned
 * answer moves its idea of where the screen starts and every redraw after it —
 * including the highlighted row of an approval prompt — lands on the wrong
 * lines.
 *
 * None is bad too, which is the part Mission Control got wrong: while the grid
 * is open the normal panel is unmounted, so a tile that swallows every query is
 * the only renderer there is and the agent waits for a reply that never comes.
 *
 * So the rule is one voice, not no voice. A renderer swallows a query when it
 * is not the voice, and lets xterm answer when it is; the main process holds
 * the actual designation, so the answer is dropped there if two renderers ever
 * think they own it at once.
 */

/** DEC private mode for focus in/out reporting. */
const FOCUS_REPORTING_MODE = 1004;

type CsiParams = readonly (number | number[])[];
export type CsiHandler = (params: CsiParams) => boolean;

export interface CsiIdentifier {
  prefix?: string;
  intermediates?: string;
  final: string;
}

/** The part of xterm's parser this needs, so the arbitration can be tested. */
export interface QueryCapableParser {
  registerCsiHandler(id: CsiIdentifier, handler: CsiHandler): IDisposable;
}

/**
 * The queries a secondary renderer must arbitrate.
 *
 * Anything here produces a reply on the byte stream that carries keystrokes,
 * so an unarbitrated renderer injects an answer to a question that was not
 * asked of it. `t` covers both xterm's window reports and the image addon's
 * cell/pixel size reports, which image-emitting tools use to decide how large
 * to draw.
 */
export const TERMINAL_QUERY_SEQUENCES: readonly CsiIdentifier[] = [
  { final: 'n' },                                        // DSR
  { prefix: '?', final: 'n' },                           // DECDSR
  { final: 'c' },                                        // DA1
  { prefix: '>', final: 'c' },                           // DA2
  { prefix: '=', final: 'c' },                           // DA3
  { prefix: '>', final: 'q' },                           // XTVERSION
  { final: 't' },                                        // window / size reports
  { prefix: '?', intermediates: '$', final: 'p' },       // DECRQM
];

export interface TerminalQueryPolicy {
  /**
   * True when this renderer owns the PTY's voice right now.
   *
   * Read per query rather than captured: which renderer owns the voice changes
   * as tiles take and give up the keyboard, and rebuilding a terminal for that
   * would cost a re-hydrate at the exact moment the user starts typing.
   */
  canAnswer(): boolean;
  /**
   * Called immediately before xterm produces the reply, so the caller can tell
   * the bytes that follow apart from a keystroke. xterm emits the answer
   * synchronously while the parser is still inside this sequence.
   */
  onAnswering(): void;
}

/**
 * Arbitrate terminal queries on a renderer that may or may not be the voice.
 *
 * Returning `true` marks a sequence handled, so xterm's own reply never runs;
 * returning `false` falls through to the built-in handler — and to any addon
 * handler registered earlier, which is why these must be registered *after*
 * the image addon is loaded. xterm tries handlers newest first.
 *
 * Focus reporting is refused outright rather than arbitrated: a tile taking
 * the keyboard is not the agent's terminal gaining focus, and enabling the
 * mode would have every hover and blur write to the PTY.
 */
export function registerTerminalQueryHandlers(
  parser: QueryCapableParser,
  policy: TerminalQueryPolicy,
): IDisposable[] {
  const arbitrate = () => {
    if (!policy.canAnswer()) return true;
    policy.onAnswering();
    return false;
  };

  const refuseFocusReporting = (params: CsiParams) =>
    params.length === 1 && params[0] === FOCUS_REPORTING_MODE;

  return [
    ...TERMINAL_QUERY_SEQUENCES.map(sequence => parser.registerCsiHandler(sequence, arbitrate)),
    parser.registerCsiHandler({ prefix: '?', final: 'h' }, refuseFocusReporting),
    parser.registerCsiHandler({ prefix: '?', final: 'l' }, refuseFocusReporting),
  ];
}
