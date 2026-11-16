import { describe, expect, it } from 'vitest';
import type { CleanupRun } from '../../../../shared/types/machineHealth';
import { OtherApps, type AppProcessRow, type OtherAppsDeps } from './otherApps';

const PANE_PID = 500;

const row = (pid: number, path: string, rssMB: number, over: Partial<AppProcessRow> = {}): AppProcessRow =>
  ({ pid, ppid: 1, started: `s${pid}`, rssKB: rssMB * 1024, cpuSeconds: 0, path, otherUser: false, ...over });

const CHROME = '/Applications/Google Chrome.app';
const SIM = '/Library/Developer/CoreSimulator/Volumes/iOS_24A434/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.0.simruntime/Contents/Resources/RuntimeRoot';
const macTable = (): AppProcessRow[] => [
  row(1, '/sbin/launchd', 20, { ppid: 0, otherUser: true }),
  row(90, '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal', 150),
  row(91, '/bin/zsh', 5, { ppid: 90 }),
  row(PANE_PID, '/Users/me/Pane/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', 300, { ppid: 91 }),
  row(501, '/Users/me/Pane/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)', 400, { ppid: PANE_PID }),
  row(502, '/bin/zsh', 6, { ppid: PANE_PID }), // a tab's shell: shown in Per Pane, not here
  row(600, '/opt/homebrew/bin/node', 120), // an escaped Pane process, credited to a Pane
  row(10, `${CHROME}/Contents/MacOS/Google Chrome`, 500),
  row(11, `${CHROME}/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)`, 700, { ppid: 10 }),
  row(12, `${CHROME}/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (GPU).app/Contents/MacOS/Google Chrome Helper (GPU)`, 300, { ppid: 10 }),
  row(20, '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder', 200),
  row(30, '/Applications/Pane.app/Contents/MacOS/Pane', 600),
  row(40, '/usr/local/bin/node', 90),
  row(41, '/Users/me/.nvm/versions/node/v22/bin/node', 70),
  row(50, '/System/Applications/Notes.app/Contents/MacOS/Notes', 80),
  row(60, `${SIM}/System/Library/CoreServices/SpringBoard.app/SpringBoard`, 40),
  row(61, `${SIM}/usr/libexec/profiled`, 30),
];

function apps(over: Partial<OtherAppsDeps> = {}, tables: AppProcessRow[][] = [macTable()]) {
  let read = 0;
  let clock = 0;
  const stopped: string[][] = [];
  const runs: CleanupRun[] = [];
  const deps: OtherAppsDeps = {
    platform: 'darwin',
    selfPid: PANE_PID,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    read: async () => tables[Math.min(read++, tables.length - 1)],
    paneProcesses: () => new Set([600]),
    stop: async identities => { stopped.push(identities.map(identity => `${identity.pid}:${identity.started}`)); return []; },
    record: run => runs.push(run),
    ...over,
  };
  return { apps: new OtherApps(deps), stopped, runs, advance: (ms: number) => { clock += ms; } };
}

describe('OtherApps.list', () => {
  it('folds each macOS app bundle (and each simulator runtime) with its helpers into one app, biggest memory first, without Pane\'s own processes', async () => {
    const list = await apps().apps.list();
    expect(list.map(app => [app.name, Math.round(app.rssMB), app.processCount])).toEqual([
      ['Google Chrome', 1500, 3],
      ['Pane', 600, 1],
      ['Finder', 200, 1],
      ['node', 160, 2],
      ['Terminal', 150, 1],
      ['Notes', 80, 1],
      ['iOS 27.0 Simulator', 70, 2],
      ['launchd', 20, 1],
      ['zsh', 5, 1],
    ]);
  });

  it('protects system processes, Pane itself and the apps Pane runs inside; ordinary apps can stop', async () => {
    const list = await apps().apps.list();
    const reason = (name: string) => list.find(app => app.name === name)?.protectedReason;
    expect(reason('Google Chrome')).toBeNull();
    expect(reason('node')).toBeNull();
    // A built-in app outside /System/Library is the person's to quit.
    expect(reason('Notes')).toBeNull();
    expect(reason('Finder')).toMatch(/macOS/u);
    expect(reason('launchd')).toMatch(/macOS/u);
    expect(reason('Pane')).toMatch(/Pane/u);
    expect(reason('Terminal')).toMatch(/Pane runs inside/u);
    expect(reason('zsh')).toMatch(/Pane runs inside/u);
  });

  it('reports CPU from the change in CPU time between two reads a second apart', async () => {
    const first = macTable();
    const second = macTable().map(proc => (proc.pid === 10 ? { ...proc, cpuSeconds: 0.5 } : proc.pid === 11 ? { ...proc, cpuSeconds: 0.25 } : proc));
    const list = await apps({}, [first, second]).apps.list();
    expect(list.find(app => app.name === 'Google Chrome')?.cpuPercent).toBe(75);
    expect(list.find(app => app.name === 'Finder')?.cpuPercent).toBe(0);
  });

  it('groups Windows processes by executable and protects Windows\' own and other sessions\' processes', async () => {
    const table = [
      row(4, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 300),
      row(5, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 200),
      row(6, 'C:\\Windows\\explorer.exe', 100),
      row(7, 'svchost.exe', 50, { otherUser: true }),
      row(8, 'C:\\Users\\me\\AppData\\Local\\Programs\\Pane\\Pane.exe', 400),
    ];
    const list = await apps({ platform: 'win32', paneProcesses: () => new Set() }, [table]).apps.list();
    expect(list.map(app => [app.name, app.processCount, app.protectedReason === null])).toEqual([
      ['chrome', 2, true],
      ['Pane', 1, false],
      ['explorer', 1, false],
      ['svchost', 1, false],
    ]);
    expect(list.find(app => app.name === 'explorer')?.protectedReason).toMatch(/Windows/u);
  });
});

describe('OtherApps.stop', () => {
  it('stops every process of the app it names, as it runs now, and records the stop', async () => {
    const { apps: other, stopped, runs } = apps();
    await other.stop(CHROME, 'ui');
    expect(stopped).toEqual([['10:s10', '11:s11', '12:s12']]);
    expect(runs.map(run => run.removed.map(entry => [entry.kind, entry.path]))).toEqual([[['app', 'Google Chrome']]]);
  });

  it('refuses a protected app and stops nothing', async () => {
    const { apps: other, stopped } = apps();
    await expect(other.stop('/System/Library/CoreServices/Finder.app', 'ui')).rejects.toMatchObject({ code: 'ERR_MACHINE_APP_PROTECTED' });
    await expect(other.stop('/Applications/Pane.app', 'ui')).rejects.toMatchObject({ code: 'ERR_MACHINE_APP_PROTECTED' });
    expect(stopped).toEqual([]);
  });

  it('says so when the app is no longer running', async () => {
    const { apps: other, stopped } = apps();
    await expect(other.stop('/Applications/Gone.app', 'ui')).rejects.toMatchObject({ code: 'ERR_MACHINE_APP_GONE' });
    expect(stopped).toEqual([]);
  });

  it('fails, naming the app, when some of its processes keep running', async () => {
    const { apps: other, runs } = apps({ stop: async identities => [identities[0]] });
    await expect(other.stop(CHROME, 'ui')).rejects.toMatchObject({ code: 'ERR_MACHINE_APP_STILL_RUNNING', message: expect.stringContaining('Google Chrome') });
    expect(runs[0]?.skipped.map(entry => entry.path)).toEqual(['Google Chrome']);
  });
});
