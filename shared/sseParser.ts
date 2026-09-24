export interface ParsedSseEvent {
  event: string;
  data: string;
}

/** Parses decoded SSE text; each transport owns its streaming UTF-8 decoder. */
export class PaneSseParser {
  private line = '';
  private eventName = 'message';
  private dataLines: string[] = [];
  private skipLineFeed = false;
  private atStart = true;

  push(chunk: string): ParsedSseEvent[] {
    if (!chunk) return [];
    if (this.atStart) {
      chunk = chunk.replace(/^\uFEFF/, '');
      this.atStart = false;
    }
    if (this.skipLineFeed) {
      chunk = chunk.replace(/^\n/, '');
      this.skipLineFeed = false;
    }

    const events: ParsedSseEvent[] = [];
    let offset = 0;
    for (const match of chunk.matchAll(/\r\n|\r|\n/g)) {
      this.line += chunk.slice(offset, match.index);
      this.consumeLine(events);
      this.line = '';
      offset = match.index + match[0].length;
      this.skipLineFeed = match[0] === '\r' && offset === chunk.length;
    }
    this.line += chunk.slice(offset);
    return events;
  }

  reset(): void {
    this.line = '';
    this.eventName = 'message';
    this.dataLines = [];
    this.skipLineFeed = false;
    this.atStart = true;
  }

  private consumeLine(events: ParsedSseEvent[]): void {
    if (!this.line) {
      if (this.dataLines.length > 0) {
        events.push({ event: this.eventName, data: this.dataLines.join('\n') });
      }
      this.eventName = 'message';
      this.dataLines = [];
      return;
    }

    const separator = this.line.indexOf(':');
    const field = separator === -1 ? this.line : this.line.slice(0, separator);
    const value = separator === -1 ? '' : this.line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') this.eventName = value || 'message';
    if (field === 'data') this.dataLines.push(value);
  }
}
