import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MachineMark, MachineRowMark, machineMarkTitle } from './MachineMark';

describe('MachineMark', () => {
  it('draws the letters on the machine colour in a fixed 18px box for rows', () => {
    const markup = renderToStaticMarkup(<MachineMark letters="TL" slot={2} size="row" />);
    expect(markup).toContain('width:18px;height:18px;color:var(--color-machine-3)');
    expect(markup).toContain('>TL</span>');
  });

  it('reads a row mark as "on <name>" and titles it with the name and OS', () => {
    const markup = renderToStaticMarkup(<MachineRowMark machine={{ name: 'travel-laptop', letters: 'T', slot: 0 }} />);
    expect(markup).toMatch(/role="img" aria-label="on travel-laptop"/);
    expect(machineMarkTitle({ name: 'travel-laptop', os: 'macOS' })).toBe('travel-laptop · macOS');
    expect(machineMarkTitle({ name: 'cloud-vm', os: null })).toBe('cloud-vm');
  });
});
