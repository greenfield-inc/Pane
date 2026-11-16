export interface ElectronProcessInfo {
  pid: number;
  type: string;
  label: string;
  cpuPercent: number;
  memoryMB: number;
}

export interface ChildProcessInfo {
  pid: number;
  name: string;
  /** The full command line, at most 200 characters, when the OS gives it. */
  command?: string;
  cpuPercent: number;
  memoryMB: number;
  /** Start time as the OS reports it; with the pid it names one process lifetime. */
  started: string;
  /** The tab that started it, when Pane knows. */
  panelId: string | null;
  /** Found by its PANE_SESSION_ID after it left its tab's process tree. */
  escaped: boolean;
}

export interface SessionResourceInfo {
  sessionId: string;
  sessionName: string;
  totalCpuPercent: number;
  totalMemoryMB: number;
  children: ChildProcessInfo[];
}

export interface ResourceSnapshot {
  timestamp: number;
  cpuReady: boolean;
  totalCpuPercent: number;
  totalMemoryMB: number;
  electronProcesses: ElectronProcessInfo[];
  sessions: SessionResourceInfo[];
}
