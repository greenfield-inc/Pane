import { describe, expect, it } from 'vitest';
import { parseTopFootprints } from './footprint';

describe('parseTopFootprints', () => {
  it('reads each process footprint from top, in MB', () => {
    const stdout = [
      'Processes: 903 total, 4 running, 899 sleeping, 5180 threads',
      '',
      'PID    MEM ',
      '98944  315M',
      '98926  134M+',
      '1      21G',
      '412    900K',
      '77     12B',
    ].join('\n');
    expect(parseTopFootprints(stdout)).toEqual(new Map([[98944, 315], [98926, 134], [1, 21504], [412, 0.9], [77, 0]]));
  });
});
