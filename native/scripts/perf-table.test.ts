import { describe, expect, it } from 'vitest';

import { formatTable, runCountMismatches, scenarioMetrics } from './perf-table.mjs';

// Two returns to a Pane's terminal tab, as the simulator log stream prints them.
const log = `
2026-11-16 16:40:01.000 Pane[123:456] [javascript] [perf] return start 0
2026-11-16 16:40:01.020 Pane[123:456] [javascript] [perf] return first-frame 18
[perf] return send=runpane:workspace:state#a1b2@k9x0 20
[perf] return send=terminal:getState#c3d4@k9x0 22
[perf] return stream-request@k9x0 25
[perf] return write=mobile:push-status@zz11 30
[perf] return write=terminal:setVisibility@k9x0 31
[perf] return read=runpane:workspace:state#a1b2@k9x0 310
[perf] return stream-open@k9x0 900
[perf] return status=restoring 1210
[perf] return send=runpane:workspace:state#a1b2@k9x0 1215
[perf] return send=panels:list#e5f6@k9x0 1216
[perf] return send=panels:list#0000@k9x0 1217
[perf] return send=terminal:getState#c3d4@k9x0 1300
[perf] return terminal-screen 1700
[perf] return status=connected 1900
[perf] return terminal-live 1950
[perf] app stall 140
[perf] return start 0
[perf] return first-frame 16
[perf] return stream-open@k9x0 700
[perf] return send=terminal:getState#c3d4@k9x0 710
[perf] return terminal-screen 1100
[perf] return terminal-live 1000
[perf] return status=connected 990
unrelated line
[perf] app stall 260
`;

describe('scenarioMetrics', () => {
  const metrics = Object.fromEntries(scenarioMetrics(log).map(metric => [metric.name, metric.values]));

  it('times each return from its start, the screen live once it is both enabled and redrawn', () => {
    expect(metrics['return: first frame']).toEqual([18, 16]);
    expect(metrics['return: connected']).toEqual([1900, 990]);
    expect(metrics['return: terminal live']).toEqual([1950, 1100]);
  });

  it('counts reads to the machine the stream goes to, a read again only with the same arguments, and writes apart', () => {
    expect(metrics['return: reads sent']).toEqual([6, 1]);
    expect(metrics['return: reads sent again']).toEqual([2, 0]);
    expect(metrics['return: writes sent']).toEqual([1, 0]);
    expect(metrics['return: terminal handshakes']).toEqual([2, 1]);
  });

  it('collects stalls across the log', () => {
    expect(metrics['stalls over 100 ms']).toEqual([2]);
    expect(metrics['longest stall']).toEqual([260]);
  });
});

describe('runCountMismatches', () => {
  it('names each journey that ran a different number of times than asked', () => {
    expect(runCountMismatches(log, 2)).toEqual([]);
    expect(runCountMismatches(log, 5)).toEqual(['return: 2']);
  });
});

describe('launch counts', () => {
  it('counts every change after the first numbers, and each number the fresh data contradicts', () => {
    const launch = ['start 0', 'home-frame 300', 'counts=- 300', 'counts=0/0/0/12 800', 'counts=6/0/0/12 2260', 'counts=7/4/0/80 2680', 'home-fresh 2680']
      .map(line => `[perf] launch ${line}`).join('\n');
    const metrics = Object.fromEntries(scenarioMetrics(launch).map(metric => [metric.name, metric.values]));
    expect(metrics['launch: count changes']).toEqual([2]);
    expect(metrics['launch: wrong counts shown']).toEqual([2]);
    expect(metrics['launch: home fresh']).toEqual([2680]);
  });
});

describe('approval layout', () => {
  it('counts every move of a region after it first appears, and takes the last as the moment the layout is final', () => {
    // The card lays out, the Pane's tabs and body appear under it, then the card grows.
    const approval = ['start 0', 'first-frame 20', 'workspace=none 5', 'card=56+120 40', 'workspace=pane 300', 'tabs=176+44 310', 'body=220+500 310', 'card=56+340 900']
      .map(line => `[perf] approval ${line}`).join('\n');
    const metrics = Object.fromEntries(scenarioMetrics(approval).map(metric => [metric.name, metric.values]));
    expect(metrics['approval: layout final']).toEqual([900]);
    expect(metrics['approval: layout changes']).toEqual([2]);
  });
});

describe('formatTable', () => {
  it('prints the median and the slowest run', () => {
    expect(formatTable([{ scenario: 'return-terminal', metrics: [{ name: 'return: terminal live', values: [1950, 1100, 1300] }] }]))
      .toBe('| Scenario | Metric | Median | Slowest | Runs |\n|---|---|---|---|---|\n| return-terminal | return: terminal live | 1300 | 1950 | 3 |');
  });
});
