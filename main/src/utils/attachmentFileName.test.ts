import { describe, expect, it } from 'vitest';
import { attachmentFileName } from './attachmentFileName';

describe('the name a chat attachment keeps on the host (D-162)', () => {
  it('keeps the original name', () => {
    expect(attachmentFileName('Quarterly report (final).pdf')).toBe('Quarterly report (final).pdf');
    expect(attachmentFileName('screenshot 2026-11-04 at 9.15.png')).toBe('screenshot 2026-11-04 at 9.15.png');
  });

  it('keeps only the base name, never a path out of its folder', () => {
    expect(attachmentFileName('../../etc/passwd')).toBe('passwd');
    expect(attachmentFileName('C:\\Users\\me\\notes.txt')).toBe('notes.txt');
    expect(attachmentFileName('..')).toBe('file');
  });

  it('replaces characters a file system refuses and trims what Windows drops', () => {
    expect(attachmentFileName('a<b>c:d"e|f?g*h\u0000.txt')).toBe('a_b_c_d_e_f_g_h_.txt');
    expect(attachmentFileName('  name.txt. ')).toBe('name.txt');
    expect(attachmentFileName('')).toBe('file');
  });

  it('shortens a very long name but keeps its extension', () => {
    const name = attachmentFileName(`${'x'.repeat(300)}.tar.gz`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith('.gz')).toBe(true);
  });
});
