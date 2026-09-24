import { StringDecoder } from 'string_decoder';
import { PaneSseParser as TextSseParser, type ParsedSseEvent } from '../../../../shared/sseParser';

/** Node transport adapter: preserve UTF-8 characters across byte chunks. */
export class PaneSseParser {
  private readonly parser = new TextSseParser();
  private decoder = new StringDecoder('utf8');

  push(chunk: Buffer | string): ParsedSseEvent[] {
    return this.parser.push(Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : chunk);
  }

  reset(): void {
    this.parser.reset();
    this.decoder = new StringDecoder('utf8');
  }
}
