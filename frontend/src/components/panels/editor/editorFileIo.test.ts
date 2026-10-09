import { afterEach, describe, expect, it, vi } from 'vitest';
import { readEditorFile } from './editorFileIo';

afterEach(() => vi.unstubAllGlobals());

describe('editor file routing', () => {
  it.each(['clip.MP4', 'clip.m4v', 'clip.mov', 'clip.webm', 'clip.mkv', 'clip.ogg', 'clip.ogv', 'C:\\clips\\demo.MP4', '\\\\wsl$\\Ubuntu\\home\\clip.webm', '/mnt/c/clips/demo.mov'])('routes %s to video without reading the bytes over IPC', async filePath => {
    const invoke = vi.fn();
    vi.stubGlobal('window', { electronAPI: { invoke } });
    expect(await readEditorFile('session', filePath)).toEqual({ kind: 'media', mediaKind: 'video' });
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each(['song.mp3', 'song.wav', 'song.m4a', 'song.aac', 'song.flac', 'song.oga'])('routes %s to audio', async filePath => {
    expect(await readEditorFile('session', filePath)).toEqual({ kind: 'media', mediaKind: 'audio' });
  });
  it('shows a binary notice for unknown binary content', async () => {
    vi.stubGlobal('window', { electronAPI: { invoke: vi.fn().mockResolvedValue({ success: false, binary: true }) } });
    expect(await readEditorFile('session', 'archive.data')).toEqual({ kind: 'unsupported' });
  });
});

it.each([
  ['diagram.svg', 'image'], ['photo.avif', 'image'], ['photo.webp', 'image'], ['animation.gif', 'image'],
  ['favicon.ico', 'image'], ['bitmap.bmp', 'image'], ['manual.pdf', 'pdf'], ['README.md', 'markdown'],
  ['page.html', 'html'], ['rows.csv', 'table'], ['rows.tsv', 'table'], ['data.json', 'structured'],
  ['events.jsonl', 'structured'], ['config.yaml', 'structured'], ['config.toml', 'structured'],
  ['face.ttf', 'font'], ['face.otf', 'font'], ['face.woff', 'font'], ['face.woff2', 'font'],
  ['bundle.zip', 'archive'], ['bundle.tar', 'archive'], ['app.sqlite', 'sqlite'],
])('routes %s to a read-only %s preview without loading its body over IPC', async (filePath, previewKind) => {
  const invoke = vi.fn();
  vi.stubGlobal('window', { electronAPI: { invoke } });
  expect(await readEditorFile('session', filePath)).toEqual({ kind: 'preview', previewKind });
  expect(invoke).not.toHaveBeenCalled();
});

it.each(['app.ts', 'notes.txt', 'Dockerfile', 'source.py'])('keeps %s in the text editor', async filePath => {
  vi.stubGlobal('window', { electronAPI: { invoke: vi.fn().mockResolvedValue({ success: true, content: 'plain text' }) } });
  expect(await readEditorFile('session', filePath)).toEqual({ kind: 'text', content: 'plain text' });
});
