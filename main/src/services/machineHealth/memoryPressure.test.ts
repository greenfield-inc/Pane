import { describe, expect, it } from 'vitest';
import { readMemoryPressure, settleLevel } from './memoryPressure';

const GB = 1024 ** 3;

describe('readMemoryPressure', () => {
  it('maps the macOS kernel pressure level (1, 2, 4)', async () => {
    const at = (value: string) => readMemoryPressure('darwin', { sysctl: async () => value, readFile: async () => '' });
    expect((await at('1\n')).level).toBe('ok');
    expect((await at('2\n')).level).toBe('warning');
    expect((await at('4\n')).level).toBe('critical');
  });

  it('reads Linux PSI from /proc/pressure/memory', async () => {
    const psi = (some: number) => `some avg10=${some.toFixed(2)} avg60=${some.toFixed(2)} avg300=1.00 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=4\n`;
    const at = (text: string) => readMemoryPressure('linux', {
      sysctl: async () => '',
      readFile: async file => (file === '/proc/pressure/memory' ? text : ''),
    });
    expect((await at(psi(2))).level).toBe('ok');
    expect((await at(psi(12.5))).level).toBe('warning');
    expect((await at(psi(45))).level).toBe('critical');
    expect((await at(psi(12.5))).source).toBe('psi');
  });

  it('falls back to MemAvailable when the kernel has no PSI', async () => {
    const meminfo = 'MemTotal:       16000000 kB\nMemFree:          100000 kB\nMemAvailable:     1200000 kB\n';
    const reading = await readMemoryPressure('linux', {
      sysctl: async () => '',
      readFile: async file => {
        if (file === '/proc/meminfo') return meminfo;
        throw new Error('ENOENT');
      },
    });
    // 1.2 of 16 GB available is 7.5%: under 10% is a warning.
    expect(reading).toMatchObject({ level: 'warning', source: 'available' });
  });

  it('uses available physical memory on Windows', async () => {
    const at = (free: number) => readMemoryPressure('win32', { sysctl: async () => '', readFile: async () => '', freemem: () => free * GB, totalmem: () => 64 * GB });
    expect((await at(20)).level).toBe('ok');
    expect((await at(5)).level).toBe('warning');
    expect((await at(2)).level).toBe('critical');
  });

  it('on a small machine, warns under 2 GB available and calls under 1 GB critical', async () => {
    const at = (free: number) => readMemoryPressure('win32', { sysctl: async () => '', readFile: async () => '', freemem: () => free * GB, totalmem: () => 8 * GB });
    expect((await at(2.5)).level).toBe('ok');
    expect((await at(1.5)).level).toBe('warning');
    expect((await at(0.9)).level).toBe('critical');
  });
});

describe('settleLevel', () => {
  it('raises a level only after two samples at or above it, and lowers it at once', () => {
    expect(settleLevel(['ok', 'warning'])).toBe('ok');
    expect(settleLevel(['warning', 'warning'])).toBe('warning');
    expect(settleLevel(['warning', 'critical'])).toBe('warning');
    expect(settleLevel(['critical', 'ok'])).toBe('ok');
    expect(settleLevel(['critical'])).toBe('ok');
  });
});
