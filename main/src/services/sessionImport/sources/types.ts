import type { ImportRunning, SessionImportSource } from '../../../../../shared/types/sessionImport';

/** Everything a reader may look at; tests and QA point it at fixture stores. */
export interface ReaderContext {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  now: number;
  /** Sessions last active before this are left out. */
  sinceMs: number;
  /** Folder for temporary copies of SQLite stores; the reader deletes its copies. */
  tempDir: string;
  isPidAlive(pid: number): boolean;
  /**
   * Executable paths (or names, where the OS hides the path) of running
   * processes, read once per scan. Rejects when the process table can't be
   * read, so a reader that needs it fails closed.
   */
  processCommands(): Promise<string[]>;
}

/** A session one tool knows about, in the tool's own terms. */
export interface FoundSession {
  source: SessionImportSource;
  /** The agent that ran it: claude, codex, cursor, opencode, or the tool's own name for another agent. */
  agent: string;
  /** The agent's own session id, the one its resume takes. */
  sessionId: string;
  folder?: string;
  branch?: string;
  title?: string;
  lastActiveMs: number;
  running: ImportRunning;
  /**
   * The transcript, when it lives in a tool-managed agent home rather than the
   * person's own store. Placement copies it into the person's store.
   */
  transcript?: { agentHome: string; path: string };
  /** Why it can't be brought in, when the reader already knows. */
  unavailable?: string;
}

export interface SourceReadResult {
  source: SessionImportSource;
  /** absent: the tool isn't on this computer. unreadable: fail closed with `reason`. */
  status: 'ok' | 'absent' | 'unreadable';
  version?: string;
  reason?: string;
  storePaths: string[];
  sessions: FoundSession[];
  /**
   * Where this tool's sessions run now, whatever their age. The scan keeps
   * other sessions out of these checkouts even when the live one is too old
   * to list.
   */
  busy?: BusyFolder[];
}

export interface BusyFolder {
  folder: string;
  agent: string;
  sessionId?: string;
}

export type SourceReader = (context: ReaderContext) => Promise<SourceReadResult>;
