import type { Locator } from '@playwright/test';

export interface TerminalSnapshot {
  lines: string[];
  selection: string;
  viewportY: number;
  baseY: number;
}

interface XtermBufferLineLike {
  translateToString(trimRight?: boolean): string;
}

interface XtermBufferLike {
  baseY: number;
  cursorY: number;
  length: number;
  viewportY: number;
  getLine(index: number): XtermBufferLineLike | undefined;
}

export interface TerminalThemeSnapshot {
  background?: string;
}

interface XtermOptionsLike {
  buffer: { active: XtermBufferLike };
  options: { theme?: TerminalThemeSnapshot; fontSize?: number };
}

interface XtermLike extends XtermOptionsLike {
  element?: HTMLElement;
  getSelection(): string;
  scrollLines(lines: number): void;
  select(column: number, row: number, length: number): void;
  write(data: string, callback?: () => void): void;
}

export function xtermEvaluate<T>(
  panelLocator: Locator,
  fn: (terminal: XtermLike) => T,
): Promise<T>;
export function xtermEvaluate<T, Argument>(
  panelLocator: Locator,
  fn: (terminal: XtermLike, argument: Argument) => T,
  argument: Argument,
): Promise<T>;
export async function xtermEvaluate<T, Argument>(
  panelLocator: Locator,
  fn: ((terminal: XtermLike) => T) | ((terminal: XtermLike, argument: Argument) => T),
  argument?: Argument,
): Promise<T> {
  return evaluateXterm(panelLocator, fn.toString(), argument, true);
}

async function evaluateXterm<T, Argument>(
  panelLocator: Locator,
  fnSource: string,
  argument: Argument | undefined,
  requireWrite: boolean,
): Promise<T> {
  return panelLocator.evaluate((element, payload) => {
    interface HookNode {
      memoizedState?: unknown;
      next?: HookNode | null;
    }
    interface FiberNode {
      memoizedState?: HookNode | null;
      return?: FiberNode | null;
    }

    if (!(element instanceof HTMLElement)) {
      throw new Error('Terminal panel locator did not resolve to an HTML element');
    }
    const xtermElement = element.matches('.xterm')
      ? element
      : element.querySelector<HTMLElement>('.xterm');
    let reactElement: HTMLElement | null = xtermElement?.parentElement ?? element.parentElement;
    while (reactElement) {
      const fiberKey = Object.keys(reactElement).find((key) => key.startsWith('__reactFiber$'));
      if (fiberKey) {
        // SAFETY: React's private fiber key points to the linked fiber contract traversed below.
        let fiber = Object.getOwnPropertyDescriptor(reactElement, fiberKey)?.value as FiberNode | null;
        while (fiber) {
          let hook = fiber.memoizedState;
          while (hook) {
            const ref = hook.memoizedState;
            if (ref instanceof Object && 'current' in ref) {
              const candidate = ref.current;
              if (
                candidate instanceof Object
                && 'options' in candidate
                && 'buffer' in candidate
                && (!payload.requireWrite || (
                  'write' in candidate && candidate.write instanceof Function
                ))
              ) {
                // SAFETY: fnSource comes from a typed terminal helper callback in this module.
                const evaluate = new Function(`return (${payload.fnSource})`)() as (
                  terminal: XtermLike,
                  argument: Argument,
                ) => T;
                // SAFETY: the selected capability gate establishes the xterm API used by the callback.
                return evaluate(candidate as XtermLike, payload.argument);
              }
            }
            hook = hook.next;
          }
          fiber = fiber.return ?? null;
        }
      }
      reactElement = reactElement.parentElement;
    }
    throw new Error('Unable to find xterm Terminal ref from panel React fiber');
  }, { fnSource, argument, requireWrite });
}

export async function writeLines(panelLocator: Locator, count: number): Promise<void> {
  await xtermEvaluate(panelLocator, (terminal, lineCount) => {
    const start = terminal.buffer.active.length;
    const lines = Array.from({ length: lineCount }, (_, index) => `blur-line-${start + index}`);
    terminal.write(`${lines.join('\r\n')}\r\n`);
  }, count);
}

export async function selectFirstLine(panelLocator: Locator): Promise<void> {
  await xtermEvaluate(panelLocator, (terminal) => {
    const firstLine = terminal.buffer.active.getLine(0)?.translateToString(true) ?? '';
    terminal.select(0, 0, firstLine.length);
  });
}

export async function scrollUp(panelLocator: Locator, lines: number): Promise<void> {
  await xtermEvaluate(panelLocator, (terminal, lineCount) => {
    terminal.scrollLines(-lineCount);
  }, lines);
}

export async function readSnapshot(panelLocator: Locator): Promise<TerminalSnapshot> {
  return xtermEvaluate(panelLocator, (terminal) => {
    const buffer = terminal.buffer.active;
    const lines = Array.from({ length: buffer.length }, (_, index) => (
      buffer.getLine(index)?.translateToString(true) ?? ''
    ));
    while (lines.at(-1) === '') lines.pop();
    return {
      lines,
      selection: terminal.getSelection(),
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
    };
  });
}

export async function readTerminalTheme(panelLocator: Locator): Promise<TerminalThemeSnapshot> {
  const readTheme = (terminal: XtermOptionsLike): TerminalThemeSnapshot => ({
    background: terminal.options.theme?.background,
  });
  try {
    return await evaluateXterm(panelLocator, readTheme.toString(), undefined, false);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unable to find xterm Terminal ref')) return {};
    throw error;
  }
}

export async function loseWebglContext(panelLocator: Locator): Promise<boolean> {
  return xtermEvaluate(panelLocator, (terminal) => {
    for (const canvas of terminal.element?.querySelectorAll('canvas') ?? []) {
      const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (!context) continue;
      context.getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    }
    return false;
  });
}
