import { describe, expect, it } from 'vitest';
import { choosePath, type PathChoice, type PathProbe } from './directPath';

function run(probes: PathProbe[], start: PathChoice = { path: 'relay', streak: 0 }): PathChoice['path'][] {
  const paths: PathChoice['path'][] = [];
  let choice = start;
  for (const probe of probes) {
    choice = choosePath(choice, probe);
    paths.push(choice.path);
  }
  return paths;
}

describe('choosePath', () => {
  it('moves to the direct path after it is clearly faster for three probes in a row', () => {
    const lan = { relay: 80, direct: 3 };
    expect(run([lan, lan, lan, lan])).toEqual(['relay', 'relay', 'direct', 'direct']);
  });

  it('starts counting again when one probe in the run is not clearly faster', () => {
    const lan = { relay: 80, direct: 3 };
    expect(run([lan, lan, { relay: 80, direct: 78 }, lan, lan, lan])).toEqual(['relay', 'relay', 'relay', 'relay', 'relay', 'direct']);
  });

  it('stays put when the other path is only a little faster', () => {
    // 10% quicker, and 2 ms quicker: neither is "clearly".
    const slightly = [{ relay: 100, direct: 90 }, { relay: 10, direct: 8 }];
    expect(run([...slightly, ...slightly, ...slightly])).toEqual(['relay', 'relay', 'relay', 'relay', 'relay', 'relay']);
  });

  it('falls back to the relay at once when the direct path fails a probe', () => {
    expect(run([{ relay: 80, direct: null }], { path: 'direct', streak: 0 })).toEqual(['relay']);
  });

  it('moves back to the relay only after the relay is clearly faster for three probes', () => {
    const relayWins = { relay: 20, direct: 200 };
    expect(run([relayWins, relayWins, relayWins], { path: 'direct', streak: 0 })).toEqual(['direct', 'direct', 'relay']);
  });

  it('keeps the current path when the other one fails, or both do', () => {
    expect(run([{ relay: 80, direct: null }, { relay: null, direct: null }])).toEqual(['relay', 'relay']);
  });
});
