// Draws a Glassly frame (the elements Pane gives session.display.render) as SVG at the device's
// resolution: the mirror on Pane's phone screen and the device gallery use it. Text is drawn in a
// system font, so widths are close to the glasses', not exact.

/** The parts of a rendered element the drawing reads. */
export interface FrameElement {
  type: string;
  id?: string;
  box: { x: number; y: number; w: number; h: number };
  text?: string;
  style?: { border?: number; color?: number };
}

/** Pane lays text out at the G2 firmware's 27 px a line. */
const LINE_H = 27;

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function frameSvg(elements: readonly FrameElement[], width: number, height: number): string {
  const parts = elements.map((element) => {
    const { x, y, w, h } = element.box;
    const gray = Math.round(((element.style?.color ?? 15) / 15) * 255);
    const fill = `rgb(${Math.round(gray * 0.35)},${gray},${Math.round(gray * 0.35)})`;
    const border = element.style?.border ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="none" stroke="${fill}" stroke-width="2"/>` : '';
    const lines = (element.text ?? '').split('\n').map((line, index) => `<text x="${x + 4}" y="${y + 21 + index * LINE_H}" fill="${fill}" font-size="20" font-family="system-ui, sans-serif" xml:space="preserve">${escape(line)}</text>`).join('');
    return `${border}<svg x="${x}" y="${y - 1}" width="${w}" height="${h + 6}" overflow="hidden"><g transform="translate(${-x},${-y + 1})">${lines}</g></svg>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="What the glasses show"><rect width="${width}" height="${height}" fill="#000"/>${parts.join('')}</svg>`;
}
