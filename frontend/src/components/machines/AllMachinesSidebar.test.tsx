import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const text = (html: string) => html.replace(/<[^>]+>/g, '');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MachineOfflineBanner', () => {
  it('says when the machine went offline, that its rows are from then, and offers Retry', async () => {
    // The sidebar's stores read localStorage when they load.
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    const { MachineOfflineBanner } = await import('./AllMachinesSidebar');
    const markup = renderToStaticMarkup(
      // No zone suffix: parsed as local time, so it reads 9:14 in any time zone.
      <MachineOfflineBanner machine={{ id: 'build', name: 'build-box', os: 'Linux', slot: 1, letters: 'B' }} since="2026-10-30T09:14:00" onRetry={() => undefined} />,
    );

    // The machine's letter mark leads, hidden from screen readers.
    expect(markup).toMatch(/<span aria-hidden="true"[^>]*data-testid="machine-mark"[^>]*><span[^>]*>B<\/span><\/span>/);
    expect(text(markup)).toMatch(/^Bbuild-box went offline at 9:14\b.*Its rows are from then\.Retry$/);
  // The first import of the sidebar loads its whole store graph: 2-3 s when the full suite runs in parallel.
  }, 15_000);
});
