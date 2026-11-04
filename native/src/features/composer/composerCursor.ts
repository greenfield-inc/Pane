import { insertAtSelection, type Selection } from './insertText';

/** One mounted view owns its cursor. Old async callbacks retain their own view. */
export class ComposerCursor {
  private position: Selection | null = null;
  select(position: Selection | null): void { this.position = position; }
  insert(text: string, value: string) {
    const result = insertAtSelection(text, this.position, value);
    this.position = { start: result.cursor, end: result.cursor };
    return { text: result.text, selection: this.position };
  }
}
