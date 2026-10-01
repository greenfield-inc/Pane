import { describe, expect, it } from 'vitest';
import { findAgentSpawnedShells, parseProcStat, type ProcessEntry } from './processTree';

describe('parseProcStat', () => {
  it('reads pid, ppid and a name with spaces and parentheses', () => {
    expect(parseProcStat('4242 (tmux: server (1)) S 17 4242 4242 0 -1 4194560')).toEqual({ pid: 4242, ppid: 17, name: 'tmux: server (1)' });
  });

  it('rejects garbage', () => {
    expect(parseProcStat('not a stat line')).toBeUndefined();
  });
});

describe('findAgentSpawnedShells', () => {
  const table: ProcessEntry[] = [
    { pid: 10, ppid: 1, name: 'bash' },
    { pid: 11, ppid: 10, name: 'claude' },
    { pid: 12, ppid: 11, name: 'cua-driver' },
    { pid: 13, ppid: 11, name: 'bash' },
    { pid: 14, ppid: 13, name: 'sleep' },
    { pid: 20, ppid: 1, name: 'bash' },
  ];

  it('finds shells the agent started, not the panel shell or MCP servers', () => {
    expect(findAgentSpawnedShells(table, 10)).toEqual([{ pid: 13, ppid: 11, name: 'bash' }]);
  });

  it('sees through a shell wrapper around the agent', () => {
    const wrapped: ProcessEntry[] = [
      { pid: 30, ppid: 1, name: 'bash' },
      { pid: 31, ppid: 30, name: 'bash' },
      { pid: 32, ppid: 31, name: 'codex' },
    ];
    expect(findAgentSpawnedShells(wrapped, 30)).toEqual([]);
    expect(findAgentSpawnedShells([...wrapped, { pid: 33, ppid: 32, name: 'sh' }], 30)).toEqual([{ pid: 33, ppid: 32, name: 'sh' }]);
  });

  it('is empty for an idle agent or an unknown pty', () => {
    expect(findAgentSpawnedShells(table.filter(entry => entry.pid !== 13 && entry.pid !== 14), 10)).toEqual([]);
    expect(findAgentSpawnedShells(table, 999)).toEqual([]);
  });
});
