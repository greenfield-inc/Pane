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
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
    expect(name.endsWith('.gz')).toBe(true);
  });

  it('bounds a name by its encoded bytes, never splitting a character (F-22)', () => {
    const name = attachmentFileName(`${'文'.repeat(100)}.txt`);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
    expect(name.endsWith('.txt')).toBe(true);
    expect(name).not.toContain('\ufffd');
    const emoji = attachmentFileName(`${'😀'.repeat(100)}.png`);
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(200);
    expect([...emoji.replace(/\.png$/, '')].every(char => char === '😀')).toBe(true);
  });

  it('rewrites the base names Windows reserves, in any case and with any extension (F-22)', () => {
    expect(attachmentFileName('CON.txt')).toBe('_CON.txt');
    expect(attachmentFileName('nul')).toBe('_nul');
    expect(attachmentFileName('Aux.tar.gz')).toBe('_Aux.tar.gz');
    expect(attachmentFileName('COM1.log')).toBe('_COM1.log');
    expect(attachmentFileName('console.txt')).toBe('console.txt');
  });
});
