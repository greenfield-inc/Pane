import fs from 'fs';
import path from 'path';
import type {
  ImportSessionResult,
  SessionImportRunResult,
} from '../../../../shared/types/sessionImport';
import { reasonOf } from '../../../../shared/paneError';
import { writeRecordEntry, type MigrationRecordEntry } from './record';
import { SOURCE_NAMES, type ScannedSession } from './scan';

/** How a launched tab ended its readiness check. */
export type TabCheck =
  | { state: 'ready' }
  | { state: 'trust' }
  | { state: 'failed'; reason: string };

/** The Pane operations placement drives; the app wires them to the runpane commands. */
export interface PlacementPort {
  /** Registers the repository once and returns its id. */
  addRepo(repoRoot: string): Promise<number>;
  /** The live Pane that already owns this checkout, if any. */
  paneForCheckout(checkout: string): { paneId: string; name: string } | undefined;
  /** Adopt the checkout in place as a Pane whose first tab resumes `resume`. */
  adopt(repoId: number, checkout: string, name: string, agent: string, resume: string): Promise<{ paneId: string; panelId: string }>;
  /** Another tab in a Pane, resuming `resume`. */
  addTab(paneId: string, agent: string, resume: string): Promise<{ panelId: string }>;
  /** The agent session id Pane stored on the tab for restarts. */
  storedResumeId(panelId: string): string | undefined;
  waitReady(panelId: string): Promise<TabCheck>;
  closeTab(panelId: string): Promise<void>;
  /** Archive and delete a Pane this run created; its checkout stays. */
  rollbackPane(paneId: string): Promise<void>;
}

/** Where the person's own agent stores are, for the transcript copy rule. */
interface PersonStores {
  claudeConfigDir: string;
  codexHome: string;
}

export interface PlacementOptions {
  sessions: ScannedSession[];
  port: PlacementPort;
  stores: PersonStores;
  paneDir: string;
  now?: () => Date;
  onProgress?: (session: ScannedSession) => void;
}

interface Placed {
  session: ScannedSession;
  paneId: string;
  paneName: string;
  panelId: string;
  newPane: boolean;
}

const RERUN_NEXT = "Say 'migrate to Pane' in Pane Chat to try it another way.";

/**
 * Turn the chosen sessions into Panes and tabs, each resumed by its own id:
 * one Pane per checkout, adopted in place, and one tab per session. Every tab
 * starts before any is checked; a tab that fails is closed, and a Pane whose
 * sessions all failed is rolled back.
 */
export async function placeSessions(options: PlacementOptions): Promise<SessionImportRunResult> {
  const { port, stores, paneDir } = options;
  const now = options.now ?? (() => new Date());
  const results = new Map<string, ImportSessionResult>();
  const placed: Placed[] = [];
  const createdPanes = new Set<string>();

  const finish = (session: ScannedSession, result: Omit<ImportSessionResult, 'key' | 'source' | 'agent' | 'title'>) => {
    results.set(session.key, { key: session.key, source: session.source, agent: session.agent, title: session.title, ...result });
    options.onProgress?.(session);
  };
  const record = (session: ScannedSession, result: MigrationRecordEntry['result'], paneId: string | null, panelId: string | null) => {
    writeRecordEntry(paneDir, {
      tool: session.agent, id: session.sessionId, folder: session.folder ?? '', paneId, panelId, forkId: null,
      result, at: now().toISOString(), source: session.source,
    });
  };

  const byCheckout = new Map<string, { repoRoot: string; sessions: ScannedSession[] }>();
  for (const session of options.sessions) {
    const missing = transcriptProblem(session, stores);
    if (missing || !session.checkout || !session.repoRoot) {
      finish(session, { outcome: 'not continued', reason: missing ?? `Its folder isn't in a git checkout. ${RERUN_NEXT}` });
      record(session, 'not continued', null, null);
      continue;
    }
    const entry = byCheckout.get(session.checkout) ?? { repoRoot: session.repoRoot, sessions: [] };
    entry.sessions.push(session);
    byCheckout.set(session.checkout, entry);
  }

  const repoIds = new Map<string, Promise<number>>();
  for (const [checkout, { repoRoot, sessions: group }] of byCheckout) {
    let pane = port.paneForCheckout(checkout);
    let queue = group;
    try {
      const pendingRepo = repoIds.get(repoRoot) ?? port.addRepo(repoRoot);
      repoIds.set(repoRoot, pendingRepo);
      const repoId = await pendingRepo;
      if (!pane) {
        const [first, ...rest] = group;
        copyTranscript(first, stores);
        const name = path.basename(checkout);
        const adopted = await port.adopt(repoId, checkout, name, first.agent, first.sessionId);
        pane = { paneId: adopted.paneId, name };
        createdPanes.add(adopted.paneId);
        placed.push({ session: first, paneId: adopted.paneId, paneName: name, panelId: adopted.panelId, newPane: true });
        record(first, 'pending', adopted.paneId, adopted.panelId);
        queue = rest;
      }
    } catch (error) {
      for (const session of group) {
        finish(session, { outcome: 'not continued', reason: `Pane couldn't open ${checkout}: ${reasonOf(error)}. ${RERUN_NEXT}` });
        record(session, 'not continued', null, null);
      }
      continue;
    }
    for (const session of queue) {
      try {
        copyTranscript(session, stores);
        const { panelId } = await port.addTab(pane.paneId, session.agent, session.sessionId);
        placed.push({ session, paneId: pane.paneId, paneName: pane.name, panelId, newPane: createdPanes.has(pane.paneId) });
        record(session, 'pending', pane.paneId, panelId);
      } catch (error) {
        finish(session, { outcome: 'not continued', reason: `Pane couldn't open a tab for it: ${reasonOf(error)}. ${RERUN_NEXT}` });
        record(session, 'not continued', null, null);
      }
    }
  }

  const checks = await Promise.all(placed.map(async item => {
    if (port.storedResumeId(item.panelId) !== item.session.sessionId) {
      return { item, check: { state: 'failed', reason: 'Pane did not store its session id for restarts' } satisfies TabCheck };
    }
    return { item, check: await port.waitReady(item.panelId).catch((error: Error): TabCheck => ({ state: 'failed', reason: reasonOf(error) })) };
  }));

  const survivingTabs = new Map<string, number>();
  for (const { item, check } of checks) {
    const base = { paneId: item.paneId, paneName: item.paneName, panelId: item.panelId };
    if (check.state === 'ready') {
      finish(item.session, { ...base, outcome: 'continued' });
      record(item.session, 'continued', item.paneId, item.panelId);
    } else if (check.state === 'trust') {
      finish(item.session, { ...base, outcome: 'waiting for trust' });
    } else {
      await port.closeTab(item.panelId).catch(() => undefined);
      finish(item.session, {
        outcome: 'not continued',
        reason: `${agentLabel(item.session)} didn't resume it: ${check.reason}. ${RERUN_NEXT}`,
      });
      record(item.session, 'not continued', null, null);
      continue;
    }
    survivingTabs.set(item.paneId, (survivingTabs.get(item.paneId) ?? 0) + 1);
  }

  let panesCreated = 0;
  for (const paneId of createdPanes) {
    if (survivingTabs.has(paneId)) {
      panesCreated += 1;
    } else {
      await port.rollbackPane(paneId).catch(error => console.error(`[SessionImport] Failed to roll back Pane ${paneId}:`, error));
    }
  }

  const ordered = options.sessions.map(session => results.get(session.key)).filter((result): result is ImportSessionResult => Boolean(result));
  const tabsInExistingPanes = ordered.filter(result =>
    result.paneId && !createdPanes.has(result.paneId) && (result.outcome === 'continued' || result.outcome === 'waiting for trust')).length;
  return { results: ordered, panesCreated, tabsInExistingPanes };
}

function agentLabel(session: ScannedSession): string {
  return session.agent === 'claude' ? 'Claude Code' : session.agent === 'codex' ? 'Codex' : session.agent;
}

function personStore(agent: string, stores: PersonStores): string | undefined {
  if (agent === 'claude') return stores.claudeConfigDir;
  if (agent === 'codex') return stores.codexHome;
  return undefined;
}

/** Whether the person's own store holds a transcript for this session id. */
function personStoreHas(agent: string, sessionId: string, stores: PersonStores): boolean {
  if (agent === 'claude') {
    const projects = path.join(stores.claudeConfigDir, 'projects');
    return listDirs(projects).some(project => fs.existsSync(path.join(projects, project, `${sessionId}.jsonl`)));
  }
  if (agent === 'codex') {
    const sessions = path.join(stores.codexHome, 'sessions');
    for (const year of listDirs(sessions)) {
      for (const month of listDirs(path.join(sessions, year))) {
        for (const day of listDirs(path.join(sessions, year, month))) {
          const files = safeReaddir(path.join(sessions, year, month, day));
          if (files.some(file => file.startsWith('rollout-') && file.endsWith(`${sessionId}.jsonl`))) return true;
        }
      }
    }
    return false;
  }
  return true;
}

/**
 * Why this session can't resume from the person's own store, or undefined
 * when it can (already there, or copyable from the tool's agent folder).
 */
function transcriptProblem(session: ScannedSession, stores: PersonStores): string | undefined {
  if (personStoreHas(session.agent, session.sessionId, stores)) return undefined;
  if (session.transcript && personStore(session.agent, stores) && fs.existsSync(session.transcript.path)) return undefined;
  if (session.transcript) {
    return `its conversation is in ${SOURCE_NAMES[session.source]}'s own ${agentLabel(session)} folder, which Pane can't copy from for this agent. ${RERUN_NEXT}`;
  }
  return `${agentLabel(session)} has no saved conversation with this id on this computer, so there is nothing to resume.`;
}

/**
 * Copy a transcript kept in a tool-managed agent folder into the person's own
 * store at the same relative path, once. The source file is never changed.
 */
function copyTranscript(session: ScannedSession, stores: PersonStores): void {
  const target = personStore(session.agent, stores);
  if (!session.transcript || !target || personStoreHas(session.agent, session.sessionId, stores)) return;
  const relative = path.relative(session.transcript.agentHome, session.transcript.path);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`transcript ${session.transcript.path} is outside ${session.transcript.agentHome}`);
  }
  const destination = path.join(target, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(session.transcript.path, destination, fs.constants.COPYFILE_EXCL);
}

function listDirs(folder: string): string[] {
  try {
    return fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return [];
  }
}

function safeReaddir(folder: string): string[] {
  try {
    return fs.readdirSync(folder);
  } catch {
    return [];
  }
}
