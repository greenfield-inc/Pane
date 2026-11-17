import { describe, expect, it } from 'vitest';
import type { CleanupRun } from '../../../../shared/types/machineHealth';
import { OtherApps, parseAppProcessTable, type AppProcessRow, type OtherAppsDeps } from './otherApps';

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
  row(30, '/Applications/Pane.app/Contents/MacOS/Pane', 600), // another Pane instance
  row(31, '/bin/zsh', 10, { ppid: 30 }), // its tab
  row(32, 'claude', 900, { ppid: 31, exe: '/Users/me/.local/share/claude/versions/2.1.322' }), // its agent
  row(70, 'claude', 400, { exe: '/Users/me/.local/share/claude/versions/2.1.322' }), // an agent in a plain terminal
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
  it('folds each macOS app bundle, simulator runtime and other Pane instance with what it runs into one app, biggest memory first, without this Pane\'s processes', async () => {
    const list = await apps().apps.list();
    expect(list.map(app => [app.name, Math.round(app.rssMB), app.processCount])).toEqual([
      ['Pane', 1510, 3],
      ['Google Chrome', 1500, 3],
      ['claude', 400, 1],
      ['Finder', 200, 1],
      ['node', 160, 2],
      ['Terminal', 150, 1],
      ['Notes', 80, 1],
      ['iOS 27.0 Simulator', 70, 2],
      ['launchd', 20, 1],
      ['zsh', 5, 1],
    ]);
  });

  it('leaves out what this Pane started since the last sample, below a process the sample already credits', async () => {
    // A dev build runs as Electron, so only its own tree keeps its agents out: tab shell 502 is credited, its new agent is not yet.
    const table = [...macTable(), row(503, 'claude', 300, { ppid: 502, exe: '/Users/me/.local/share/claude/versions/2.1.322' }), row(504, '/opt/homebrew/bin/node', 80, { ppid: 503 })];
    const list = await apps({ paneProcesses: () => new Set([502, 600]) }, [table]).apps.list();
    expect(list.find(app => app.name === 'claude')?.processCount).toBe(1);
    expect(list.find(app => app.name === 'node')?.processCount).toBe(2);
  });

  it('marks which apps are grouped by executable name, so the confirm can say they span other terminals', async () => {
    const list = await apps().apps.list();
    expect(list.filter(app => app.byName).map(app => app.name)).toEqual(['claude', 'node', 'launchd', 'zsh']);
  });

  it('locks Pane itself with what it runs, the iOS simulator and the apps Pane runs inside; ordinary apps can stop', async () => {
    const list = await apps().apps.list();
    const reason = (name: string) => list.find(app => app.name === name)?.protectedReason;
    expect(reason('Google Chrome')).toBeNull();
    expect(reason('node')).toBeNull();
    expect(reason('claude')).toBeNull();
    expect(reason('Pane')).toMatch(/This is Pane/u);
    expect(reason('iOS 27.0 Simulator')).toMatch(/Simulator app/u);
    expect(reason('Terminal')).toMatch(/Pane runs inside/u);
    expect(reason('zsh')).toMatch(/Pane runs inside/u);
  });

  it('leaves out locked processes under 1 MB, and sends each icon only to a screen that lacks it', async () => {
    const table = [...macTable(), row(80, '/usr/libexec/tiny', 0.5)];
    const { apps: other } = apps({ iconOf: async path => `icon:${path}` }, [table]);
    const first = await other.list();
    expect(first.some(app => app.name === 'tiny')).toBe(false);
    expect(first.find(app => app.name === 'Google Chrome')?.icon).toBe(`icon:${CHROME}`);
    const again = await other.list([CHROME]);
    expect(again.find(app => app.name === 'Google Chrome')?.icon).toBeUndefined();
    expect(again.find(app => app.name === 'Finder')?.icon).toBe('icon:/System/Library/CoreServices/Finder.app');
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

/** The reason one user-owned process, started outside Pane's tree, gets on `platform`; each case hits one rule only. */
async function reasonFor(platform: NodeJS.Platform, proc: AppProcessRow): Promise<string | null | undefined> {
  const list = await apps({ platform, paneProcesses: () => new Set() }, [[proc]]).apps.list();
  return list[0]?.protectedReason;
}

describe('which apps are system', () => {
  it.each([
    ['Finder', '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder', {}],
    ['a daemon in /usr/libexec', '/usr/libexec/sharingd', {}],
    ['a daemon in /Library/Apple', '/Library/Apple/System/Library/CoreServices/XProtect.app/Contents/MacOS/XProtect', {}],
    ['an agent in the system cryptex', '/System/Cryptexes/App/usr/libexec/AuthenticationServicesAgent', {}],
    ['a bare-name daemon whose executable is in /System', 'cloudphotod', { exe: '/System/Library/PrivateFrameworks/CloudPhotoLibrary.framework/Versions/A/Support/cloudphotod' }],
    ['another user\'s app', '/Applications/Docker.app/Contents/MacOS/com.docker.backend', { otherUser: true }],
  ])('macOS locks %s', async (_label, path, over) => {
    expect(await reasonFor('darwin', row(9, path, 50, over))).toMatch(/Part of macOS/u);
  });

  it.each([
    ['Homebrew node', '/usr/local/bin/node', {}],
    ['a built-in app the person quits', '/System/Applications/Notes.app/Contents/MacOS/Notes', {}],
    ['Safari in its cryptex', '/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari', {}],
    ['a quarantined app run from its translocation folder', '/private/var/folders/x1/T/AppTranslocation/AB12/d/Foo.app/Contents/MacOS/Foo', {}],
    ['an agent CLI named by argv[0]', 'claude', { exe: '/Users/me/.local/share/claude/versions/2.1.322' }],
  ])('macOS lets the person stop %s', async (_label, path, over) => {
    expect(await reasonFor('darwin', row(9, path, 50, over))).toBeNull();
  });

  it('macOS locks a bare-name process whose executable it could not read, unless others of its name were read', async () => {
    expect(await reasonFor('darwin', row(9, 'mystery', 50))).toMatch(/can't tell which program/u);
    const list = await apps({ paneProcesses: () => new Set() }, [[row(9, 'node', 50, { exe: '/opt/homebrew/bin/node' }), row(10, 'node', 50)]]).apps.list();
    expect(list.map(app => [app.name, app.processCount, app.protectedReason])).toEqual([['node', 2, null]]);
  });

  it.each(['ksmserver', 'kwin_wayland', 'plasmashell', 'xfce4-session', 'cinnamon', 'mate-session', 'sway', 'Hyprland', 'i3', 'gnome-shell', 'gnome-session-b', 'gnome-keyring-d', 'xdg-desktop-por', 'at-spi-bus-laun', 'pipewire-pulse', 'Xwayland'])(
    'Linux locks the desktop session process %s', async comm => {
      expect(await reasonFor('linux', row(9, comm, 50))).toMatch(/Part of the system/u);
    });

  it('Linux lets the person stop an ordinary app, and locks another user\'s', async () => {
    expect(await reasonFor('linux', row(9, 'firefox', 50))).toBeNull();
    expect(await reasonFor('linux', row(9, 'firefox', 50, { otherUser: true }))).toMatch(/Part of the system/u);
  });

  it('reads the owner from the ps table: another uid marks a process as another user\'s', () => {
    const table = [
      '  412     1   501  20480   0:01.50 Mon Nov 16 09:00:01 2026 /Applications/Slack.app/Contents/MacOS/Slack',
      '   88     1     0   8192   0:00.20 Mon Nov 16 08:59:58 2026 /usr/sbin/syslogd',
    ].join('\n');
    expect(parseAppProcessTable(table, 501).map(proc => [proc.pid, proc.otherUser, proc.rssKB, proc.cpuSeconds, proc.started, proc.path])).toEqual([
      [412, false, 20480, 1.5, 'Mon Nov 16 09:00:01 2026', '/Applications/Slack.app/Contents/MacOS/Slack'],
      [88, true, 8192, 0.2, 'Mon Nov 16 08:59:58 2026', '/usr/sbin/syslogd'],
    ]);
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
    await expect(other.stop(`${SIM.slice(0, SIM.indexOf('.simruntime') + '.simruntime'.length)}`, 'ui')).rejects.toMatchObject({ code: 'ERR_MACHINE_APP_PROTECTED' });
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
