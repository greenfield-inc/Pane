/** Which engine a machine's computer use runs on. Auto picks the Codex runtime when present (M3), else Cua Driver. */
export type ComputerUseEngineChoice = 'auto' | 'cua-driver';
export const COMPUTER_USE_ENGINE_CHOICES: readonly ComputerUseEngineChoice[] = ['auto', 'cua-driver'];

export type ComputerUseEngineName = 'cua-driver' | 'codex';
export type ComputerUsePermission = 'Screen Recording' | 'Accessibility';

/** One machine's computer-use readiness, owned by that machine's daemon. */
export type ComputerUseReadiness =
  | { state: 'off'; engineChoice: ComputerUseEngineChoice }
  | { state: 'installing'; engineChoice: ComputerUseEngineChoice }
  | { state: 'needs-permission'; engineChoice: ComputerUseEngineChoice; permission: ComputerUsePermission; appName: string }
  | { state: 'no-desktop'; engineChoice: ComputerUseEngineChoice }
  | { state: 'failed'; engineChoice: ComputerUseEngineChoice; detail: string }
  | {
      state: 'ready';
      engineChoice: ComputerUseEngineChoice;
      engine: ComputerUseEngineName;
      checkedAt: number;
      /** Set when Auto runs on Cua Driver: why the Codex runtime wasn't used. */
      detail?: string;
    };

export type ComputerUseState = ComputerUseReadiness['state'];

const ENGINE_LABELS = {
  'cua-driver': 'Cua Driver',
  codex: 'Codex runtime',
} satisfies Record<ComputerUseEngineName, string>;

export const COMPUTER_USE_ENGINE_CHOICE_LABELS = {
  auto: 'Auto',
  'cua-driver': 'Cua Driver',
} satisfies Record<ComputerUseEngineChoice, string>;

/** "just now", "5 min ago", "2 h ago", then a date. */
export function formatCheckedAt(checkedAt: number, now: number): string {
  const minutes = Math.floor((now - checkedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(checkedAt).toLocaleDateString();
}

/** The status line after "Computer use: ". Its action (Open System Settings, View details) is rendered separately. */
export function computerUseStatusText(readiness: ComputerUseReadiness, now: number): string {
  switch (readiness.state) {
    case 'off': return 'Off';
    case 'installing': return 'Installing…';
    case 'needs-permission': return `Needs permission: ${readiness.permission}`;
    case 'no-desktop': return 'No desktop session';
    case 'failed': return 'Self-test failed';
    case 'ready': return `Ready · ${ENGINE_LABELS[readiness.engine]} · checked ${formatCheckedAt(readiness.checkedAt, now)}`;
  }
}

/** Pushed with no payload when a machine's readiness changes; clients refetch `computer-use:readiness`. */
export const COMPUTER_USE_READINESS_CHANGED_EVENT = 'computer-use:readiness-changed';
