import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PhoneTab } from './PhoneTab';
import { QrCode } from './QrCode';

/** A real-sized pairing link: a 32-byte base64url secret, a relay id, and a Mac's default name with its curly apostrophe. */
const PAIRING_LINK = `https://runpane.net/pair#${new URLSearchParams({ s: 'A'.repeat(43), c: 'jlu6h6knznf3gxa3', n: 'Alex’s MacBook Pro' }).toString()}`;

/** The modules across, from the rendered viewBox, less the quiet zone on each side. */
function drawn(html: string) {
  const match = html.match(/viewBox="(-?\d+) -?\d+ (\d+) \d+"/);
  if (!match) throw new Error('no viewBox');
  const quietZone = -Number(match[1]);
  return { modules: Number(match[2]) - quietZone * 2, quietZone };
}

describe('QrCode', () => {
  it('keeps a pairing link at version 6 (41 modules), not version 7, so each module is bigger', () => {
    const { modules } = drawn(renderToStaticMarkup(<QrCode url={PAIRING_LINK} label="Pairing code" />));
    expect(modules).toBe(41);
  });

  it('draws the 4-module quiet zone cameras need', () => {
    expect(drawn(renderToStaticMarkup(<QrCode url={PAIRING_LINK} label="Pairing code" />)).quietZone).toBe(4);
  });

  it('shows the pairing code in a 264px box', () => {
    const html = renderToStaticMarkup(
      <PhoneTab view={{ step: 'code', url: PAIRING_LINK, secondsLeft: 600 }} paired={null} renewed={false} onRetry={() => undefined} onSetUpTailscale={() => undefined} />,
    );
    expect(html).toMatch(/class="[^"]*h-\[264px\] w-\[264px\][^"]*"><svg/);
    expect(html).toContain(`data-url="${PAIRING_LINK.replace(/&/g, '&amp;')}"`);
  });
});
