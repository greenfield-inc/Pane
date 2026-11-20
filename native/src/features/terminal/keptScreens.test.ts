import { describe, expect, it } from 'vitest';

import { forgetKeptScreens, keepScreen, keptScreen } from './keptScreens';

describe('kept terminal screens', () => {
  it('keeps the 20 terminals seen most recently', () => {
    for (let n = 1; n <= 21; n++) keepScreen('mac', `panel-${n}`, `screen ${n}`);
    expect(keptScreen('mac', 'panel-1')).toBeNull();
    expect(keptScreen('mac', 'panel-2')).toBe('screen 2');
    expect(keptScreen('mac', 'panel-21')).toBe('screen 21');
  });

  it('drops a screen kept as null, such as one scrolled back', () => {
    keepScreen('mac', 'logs', 'bottom rows');
    keepScreen('mac', 'logs', null);
    expect(keptScreen('mac', 'logs')).toBeNull();
  });

  it('forgets only the screens of a computer that was removed', () => {
    keepScreen('mac', 'shell', 'mac rows');
    keepScreen('mac-2', 'shell', 'other rows');
    forgetKeptScreens('mac');
    expect(keptScreen('mac', 'shell')).toBeNull();
    expect(keptScreen('mac-2', 'shell')).toBe('other rows');
  });
});
