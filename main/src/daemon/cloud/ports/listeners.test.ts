import { describe, expect, it } from 'vitest';
import { findPanelAncestor, isLocalBind, parseProcNetTcp } from './listeners';

const TCP4 = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:2253 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5001 1 0000000000000000 100 0 0 10 0
   1: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5002 1 0000000000000000 100 0 0 10 0
   2: 3F894664:2253 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5003 1 0000000000000000 100 0 0 10 0
   3: 0100007F:A499 0100007F:2253 01 00000000:00000000 00:00000000 00000000  1000        0 5004 1 0000000000000000 100 0 0 10 0
`;

const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6001 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6002 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6003 1 0000000000000000 100 0 0 10 0
`;

describe('parseProcNetTcp', () => {
  it('reads IPv4 LISTEN sockets and skips established ones', () => {
    expect(parseProcNetTcp(TCP4, 4)).toEqual([
      { port: 8787, address: '127.0.0.1', inode: 5001 },
      { port: 5173, address: '0.0.0.0', inode: 5002 },
      { port: 8787, address: '100.70.137.63', inode: 5003 },
    ]);
  });

  it('reads IPv6 loopback, wildcard and IPv4-mapped addresses', () => {
    expect(parseProcNetTcp(TCP6, 6)).toEqual([
      { port: 5173, address: '::1', inode: 6001 },
      { port: 3000, address: '::', inode: 6002 },
      { port: 8080, address: '::ffff:127.0.0.1', inode: 6003 },
    ]);
  });

  it('treats loopback and wildcard binds as local, and tailnet addresses (tailscaled) as not', () => {
    expect(['127.0.0.1', '0.0.0.0', '::', '::1'].every(isLocalBind)).toBe(true);
    expect(isLocalBind('100.70.137.63')).toBe(false);
    expect(isLocalBind('127.0.0.53')).toBe(false);
  });
});

describe('findPanelAncestor', () => {
  const table = [
    { pid: 1, ppid: 0, name: 'systemd' },
    { pid: 10, ppid: 1, name: 'bash' },
    { pid: 11, ppid: 10, name: 'claude' },
    { pid: 12, ppid: 11, name: 'node' },
    { pid: 20, ppid: 1, name: 'postgres' },
  ];
  const panels = [{ pid: 10, panelId: 'p' }];

  it('finds the panel a process descends from', () => {
    expect(findPanelAncestor(12, table, panels)?.panelId).toBe('p');
    expect(findPanelAncestor(10, table, panels)?.panelId).toBe('p');
  });

  it('ignores processes outside every panel', () => {
    expect(findPanelAncestor(20, table, panels)).toBeUndefined();
  });
});
