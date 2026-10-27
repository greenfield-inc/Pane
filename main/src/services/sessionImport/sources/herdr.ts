import fs from 'fs';
import net from 'net';
import path from 'path';
import type { ImportRunning } from '../../../../../shared/types/sessionImport';
import type { FoundSession, ReaderContext, SourceReader } from './types';
import type { JsonValue } from '../../../../../shared/validation/boundaryDecoder';
import { absent, exists, isRecord, mtimeMs, readJson, stringField, unreadable } from './common';

const SOURCE = 'herdr';
const SNAPSHOT_VERSION = 3;
const CONNECT_TIMEOUT_MS = 500;

/**
 * Herdr keeps one session.json per Herdr session: the default session in its
 * config folder, named ones in `sessions/<name>/`. Only panes whose agent
 * reported its own session id through Herdr's integration carry
 * `agent_session`. The snapshot has no timestamps, so the file's mtime stands
 * in for last activity, and a server answering on `herdr.sock` means its
 * panes are live.
 */
export const readHerdr: SourceReader = async context => {
  const configDir = herdrConfigDir(context);
  if (!exists(configDir)) return absent(SOURCE);

  const sessionDirs = [configDir];
  try {
    for (const entry of fs.readdirSync(path.join(configDir, 'sessions'), { withFileTypes: true })) {
      if (entry.isDirectory()) sessionDirs.push(path.join(configDir, 'sessions', entry.name));
    }
  } catch {
    // No named sessions.
  }

  const storePaths = sessionDirs.map(dir => path.join(dir, 'session.json'));
  const sessions: FoundSession[] = [];
  for (const dir of sessionDirs) {
    const file = path.join(dir, 'session.json');
    const lastActiveMs = mtimeMs(file);
    if (lastActiveMs === undefined || lastActiveMs < context.sinceMs) continue;

    const snapshot = readJson(file);
    if (!isRecord(snapshot) || snapshot.version !== SNAPSHOT_VERSION || !Array.isArray(snapshot.workspaces)) {
      const version = isRecord(snapshot) ? String(snapshot.version) : undefined;
      return unreadable(SOURCE, `Herdr's ${file} is in a format Pane doesn't recognise`, storePaths, version);
    }

    const panes = snapshotPanes(snapshot.workspaces);
    if (panes.length === 0) continue;
    const running = await serverRunning(context, path.join(dir, 'herdr.sock'));
    for (const pane of panes) sessions.push({ ...pane, lastActiveMs, running });
  }

  return { source: SOURCE, status: 'ok', version: String(SNAPSHOT_VERSION), storePaths, sessions };
};

function herdrConfigDir(context: ReaderContext): string {
  if (context.env.XDG_CONFIG_HOME) return path.join(context.env.XDG_CONFIG_HOME, 'herdr');
  if (context.platform === 'win32') {
    return path.join(context.env.APPDATA || path.join(context.home, 'AppData', 'Roaming'), 'herdr');
  }
  return path.join(context.home, '.config', 'herdr');
}

type PaneSession = Omit<FoundSession, 'lastActiveMs' | 'running'>;

function snapshotPanes(workspaces: JsonValue[]): PaneSession[] {
  const found: PaneSession[] = [];
  for (const workspace of workspaces.filter(isRecord)) {
    const tabs = Array.isArray(workspace.tabs) ? workspace.tabs.filter(isRecord) : [];
    for (const tab of tabs) {
      const panes = isRecord(tab.panes) ? Object.values(tab.panes).filter(isRecord) : [];
      for (const pane of panes) {
        const agentSession = isRecord(pane.agent_session) ? pane.agent_session : undefined;
        const agent = stringField(agentSession, 'agent');
        const sessionId = stringField(agentSession, 'value');
        if (!agent || !sessionId) continue;
        found.push({
          source: SOURCE,
          agent,
          sessionId,
          folder: stringField(pane, 'cwd'),
          title: stringField(pane, 'label') ?? stringField(tab, 'custom_name') ?? stringField(workspace, 'custom_name'),
        });
      }
    }
  }
  return found;
}

/**
 * Herdr's own `session list` test: a server is running when its API socket
 * accepts a connection. A missing or refusing socket means it isn't; any
 * other failure leaves it unknown.
 */
function serverRunning(context: ReaderContext, socketPath: string): Promise<ImportRunning> {
  const target = context.platform === 'win32' ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  // No socket file means no server; a connect to a long path can fail for other reasons.
  if (context.platform !== 'win32' && !exists(socketPath)) return Promise.resolve('no');
  return new Promise(resolve => {
    const socket = net.connect(target);
    const finish = (running: ImportRunning): void => {
      socket.destroy();
      resolve(running);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish('unknown'));
    socket.once('connect', () => finish('yes'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'no' : 'unknown');
    });
  });
}
