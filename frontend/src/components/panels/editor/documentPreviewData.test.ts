import { describe, expect, it } from 'vitest';
import { parseDelimitedPreview } from './documentPreviewData';

describe('delimited file preview', () => {
  it('parses quoted commas, multiline fields, escaped quotes, CRLF and empty cells', () => {
    expect(parseDelimitedPreview('name,note,empty\r\n"A, B","line 1\n""quoted""",\r\n', ',').rows).toEqual([
      ['name', 'note', 'empty'], ['A, B', 'line 1\n"quoted"', ''],
    ]);
  });
  it('parses TSV without interpreting formulas or markup', () => {
    expect(parseDelimitedPreview('name\tvalue\nx\t=SUM(A1)\ny\t<script>', '\t').rows).toEqual([
      ['name', 'value'], ['x', '=SUM(A1)'], ['y', '<script>'],
    ]);
  });
  it('bounds rows and drops a partial final record', () => {
    expect(parseDelimitedPreview('header\n' + 'row\n'.repeat(900), ',')).toMatchObject({ truncated: true });
    expect(parseDelimitedPreview('header\n' + 'row\n'.repeat(900), ',').rows).toHaveLength(501);
    expect(parseDelimitedPreview('header\n"partial', ',', true)).toEqual({ rows: [['header']], truncated: true });
  });
  it('rejects malformed quotes and excessive columns', () => {
    expect(() => parseDelimitedPreview('"unclosed', ',')).toThrow();
    expect(() => parseDelimitedPreview('"closed"junk', ',')).toThrow();
    expect(() => parseDelimitedPreview(','.repeat(100), ',')).toThrow();
  });
});
