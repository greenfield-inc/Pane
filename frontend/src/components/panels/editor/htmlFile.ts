import type { HtmlFileOpenMode } from '../../../types/config';

export function isHtmlFile(filePath: string): boolean {
  return /\.html?$/i.test(filePath);
}

/**
 * What an Explorer click on a file opens. Under the Preview setting an HTML file
 * opens rendered in a new browser tab on the gesture's first click, so the rest of
 * a double-click (its second click and the dblclick) opens nothing more.
 * `clickCount` is the click event's `detail`: 0 for the keyboard, 2 for a double-click's second click.
 */
export function explorerOpenAction(
  filePath: string,
  mode: HtmlFileOpenMode,
  gesture: { clickCount: number; doubleClick: boolean },
): 'editor' | 'preview' | 'none' {
  if (!isHtmlFile(filePath) || mode === 'source') return 'editor';
  return gesture.doubleClick || gesture.clickCount > 1 ? 'none' : 'preview';
}
