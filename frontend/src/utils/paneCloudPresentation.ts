import type { PaneCloudAction, PaneCloudMachineState, PaneCloudMachineView, PaneCloudOperation, PaneCloudStopReason, PaneCloudUsage } from '../../../shared/types/paneCloud';

interface PaneCloudBudgetText {
  used: string;
  throttled: string | null;
}

const OPERATION_LABELS = {
  create: 'Created',
  start: 'Started',
  stop: 'Stopped',
  delete: 'Deleted',
  bootstrap: 'Installed Pane',
  update_pane: 'Updated Pane',
  prepare_to_stop: 'Prepared to stop',
  collect_diagnostics: 'Collected diagnostics',
} satisfies Record<PaneCloudOperation, string>;

const STATE_LABELS = {
  creating: 'Creating',
  running: 'Running',
  stopping: 'Stopping',
  stopped: 'Stopped',
  resuming: 'Starting',
  deleting: 'Deleting',
  deleted: 'Deleted',
  error: 'Failed',
  suspended: 'Suspended',
} satisfies Record<PaneCloudMachineState, string>;

export function paneCloudStateLabel(machine: PaneCloudMachineView): string {
  return STATE_LABELS[machine.state];
}

export function paneCloudOperationLabel(action: PaneCloudAction): string {
  return OPERATION_LABELS[action.operation];
}

/** "3.5 of 12 vCPU-hours today", and once the budget is used, when full speed returns. */
export function paneCloudBudget(usage: PaneCloudUsage): PaneCloudBudgetText {
  const hours = (seconds: number) => Number((seconds / 3600).toFixed(1)).toString();
  const resets = new Date(usage.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return {
    used: `${hours(Math.min(usage.cpuSecondsUsed, usage.dailyCpuSeconds))} of ${hours(usage.dailyCpuSeconds)} vCPU-hours today`,
    throttled: usage.throttled ? `Daily CPU budget used. It runs at 0.5 vCPU until ${resets}, when full speed returns.` : null,
  };
}

const STOP_REASONS = {
  user: 'you stopped it',
  idle: 'no agent ran and no one was connected for 30 minutes',
  memory_pressure: 'the host needed memory back',
  host_maintenance: 'host maintenance',
  host_lost: 'its host was lost; it restarted elsewhere',
  abuse: 'suspended for abuse',
  billing: 'billing',
  end_of_beta: 'the beta ended',
  failed: 'it failed',
} satisfies Record<PaneCloudStopReason, string>;

export function paneCloudStopReason(reason: PaneCloudStopReason): string {
  return STOP_REASONS[reason];
}
