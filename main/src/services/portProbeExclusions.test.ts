import { describe, expect, it } from 'vitest';
import { PaneError } from '../../../shared/paneError';
import {
  ERR_PORT_PROBE_EXCLUSIONS_INVALID,
  isPortInRanges,
  parsePortRanges,
  portProbeSettingsOf,
  portRangesError,
} from '../../../shared/types/portProbes';

function refusal(text: string): PaneError {
  try {
    parsePortRanges(text);
  } catch (error) {
    if (error instanceof PaneError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(text)} to be refused`);
}

describe('port probe exclusions', () => {
  it('reads single ports and ranges, in any order and with any separators', () => {
    expect(parsePortRanges('9000-9100, 5173')).toEqual([{ from: 5173, to: 5173 }, { from: 9000, to: 9100 }]);
    expect(parsePortRanges(' 3000 ;8080\n 1-1 ,65535 ')).toEqual([
      { from: 1, to: 1 }, { from: 3000, to: 3000 }, { from: 8080, to: 8080 }, { from: 65535, to: 65535 },
    ]);
  });

  it('excludes nothing for an empty list', () => {
    expect(parsePortRanges('')).toEqual([]);
    expect(parsePortRanges(' , ,')).toEqual([]);
  });

  it('merges ranges that overlap, contain one another, touch or repeat', () => {
    expect(parsePortRanges('9000-9100, 9050-9200')).toEqual([{ from: 9000, to: 9200 }]);
    expect(parsePortRanges('9000-9100, 9010-9020, 9100')).toEqual([{ from: 9000, to: 9100 }]);
    expect(parsePortRanges('9000-9100, 9101-9110')).toEqual([{ from: 9000, to: 9110 }]);
    expect(parsePortRanges('5173, 5173, 5174')).toEqual([{ from: 5173, to: 5174 }]);
  });

  it.each([
    ['abc', '"abc" is not a whole number'],
    ['5173, 80a', '"80a" is not a whole number'],
    ['0', '0 is outside 1 to 65535'],
    ['65536', '65536 is outside 1 to 65535'],
    ['9100-9000', 'the range ends before it starts; write 9000-9100'],
    ['9000-', 'a number is missing'],
    ['-9000', 'a number is missing'],
    ['9000-9100-9200', '"9100-9200" is not a whole number'],
    ['1.5', '"1.5" is not a whole number'],
  ])('refuses %j with a PaneError that says why and what to enter', (text, why) => {
    const error = refusal(text);
    expect(error.code).toBe(ERR_PORT_PROBE_EXCLUSIONS_INVALID);
    expect(error.message).toContain(why);
    expect(error.message).toContain('The excluded ports were not changed.');
    expect(error.next).toContain('9000-9100');
    expect(portRangesError(text)).toBe(error.message);
  });

  it('finds a port at either end of a range and nowhere else', () => {
    const ranges = parsePortRanges('5173, 9000-9100');
    expect([5173, 9000, 9050, 9100].every(port => isPortInRanges(port, ranges))).toBe(true);
    expect([5172, 5174, 8999, 9101].some(port => isPortInRanges(port, ranges))).toBe(false);
  });

  it('probes every port by default, and turns probes off when the saved list does not parse', () => {
    expect(portProbeSettingsOf({})).toEqual({ enabled: true, excluded: [] });
    expect(portProbeSettingsOf({ portProbesEnabled: false, portProbeExcludedPorts: '5173' })).toEqual({ enabled: false, excluded: [{ from: 5173, to: 5173 }] });
    const broken = portProbeSettingsOf({ portProbeExcludedPorts: '9100-9000' });
    expect(broken).toMatchObject({ enabled: false, excluded: [] });
    expect(broken.error).toContain('9100-9000');
  });
});
