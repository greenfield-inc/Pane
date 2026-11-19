import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutopilotDocument } from '../../../../../shared/types/autopilot';
import { attachmentWrapperPage, openAttachmentCopy } from './attachmentPage';

const HOSTILE = '<!doctype html><script>localStorage.getItem("pane.remotePwa.savedProfiles"); opener.document.title = "x"</script><p class="a">Plan & "notes"</p>';

const decodeAttribute = (value: string) => value.replace(/&quot;/gu, '"').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');

/** The one iframe's attributes, and what sits outside it. */
function parseWrapper(page: string) {
  const frames = page.match(/<iframe\b[^>]*>/giu) ?? [];
  const frame = frames[0] ?? '';
  const attribute = (name: string) => {
    const match = new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(frame);
    return match ? decodeAttribute(match[1]) : undefined;
  };
  return { frames, sandbox: attribute('sandbox'), srcdoc: attribute('srcdoc'), outside: page.replace(frame, '') };
}

/** The tab window.open hands back: Open clears its opener and points it at the page. */
interface FakeTab { opener: object | null; location: { href: string }; close: () => void }

/** Stubs window.open with a tab the test can watch, and URL.createObjectURL with one that keeps each Blob. */
function stubBrowser() {
  const tab: FakeTab = { opener: {}, location: { href: '' }, close: vi.fn() };
  const open = vi.fn(() => tab);
  const blobs: Blob[] = [];
  vi.stubGlobal('window', { open });
  vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { blobs.push(blob); return `blob:pane/${blobs.length}`; } });
  return { tab, open, blobs };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

afterEach(() => { vi.unstubAllGlobals(); });

describe('opening an attached page outside Pane', () => {
  it('wraps the page in a sandboxed frame, never as the tab\'s own document', () => {
    const page = attachmentWrapperPage(HOSTILE, 'plan.html');
    const { frames, sandbox, srcdoc, outside } = parseWrapper(page);
    expect(page.startsWith('<!doctype html><html><head><meta charset="utf-8">')).toBe(true);
    expect(frames).toHaveLength(1);
    // No flags at all: no scripts, and above all no allow-same-origin.
    expect(sandbox).toBe('');
    expect(srcdoc).toBe(HOSTILE);
    // The attachment's markup appears only escaped inside srcdoc: nothing of it is top-level.
    expect(outside).not.toContain('<script');
    expect(outside).not.toContain('<p class');
    expect(page).not.toContain('<script');
    expect(page).toContain('script-src \'none\'');
  });

  it('a title can\'t break out of the wrapper either', () => {
    const page = attachmentWrapperPage('<p>x</p>', '"><script>alert(1)</script>');
    expect(page).not.toContain('<script');
    expect(parseWrapper(page).frames).toHaveLength(1);
  });

  it('Open: the tab is cut from the opener and shows the wrapper, not the attachment', async () => {
    const { tab, open, blobs } = stubBrowser();
    const doc: AutopilotDocument = { kind: 'html', url: 'file:///a/plan.html', path: '/a/plan.html', html: HOSTILE };
    openAttachmentCopy(async () => doc, 'plan.html');
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    await settle();
    expect(tab.location.href).toBe('blob:pane/1');
    expect(blobs[0]?.type).toBe('text/html');
    const opened = await (blobs[0] ?? new Blob()).text();
    expect(opened).toBe(attachmentWrapperPage(HOSTILE, 'plan.html'));
    expect(parseWrapper(opened).srcdoc).toBe(HOSTILE);
    expect(opened).not.toContain('<script');
  });

  it('Open: text stays plain text, and a file that can\'t show closes the tab', async () => {
    const first = stubBrowser();
    openAttachmentCopy(async () => ({ kind: 'text', path: '/a/notes.md', text: '<script>x</script>' }), 'notes.md');
    await settle();
    expect(first.blobs[0]?.type).toBe('text/plain');
    const second = stubBrowser();
    openAttachmentCopy(async () => ({ kind: 'missing', path: '/a/gone.html', message: 'gone' }), 'gone.html');
    await settle();
    expect(second.tab.close).toHaveBeenCalled();
    expect(second.blobs).toHaveLength(0);
    const third = stubBrowser();
    openAttachmentCopy(async () => { throw new Error('offline'); }, 'plan.html');
    await settle();
    expect(third.tab.close).toHaveBeenCalled();
  });
});
