import type { ScheduledRunInput } from '../../../shared/types/schedule';
import { MIN_INTERVAL_MINUTES } from '../../../shared/types/schedule';
import { parseTimeOfDay } from './scheduleCalculator';

type ScheduleValidationResult =
  | { success: true; data: ScheduledRunInput }
  | { success: false; error: string };

export function validateScheduledRunInput(input: ScheduledRunInput): ScheduleValidationResult {
  if (!input.prompt.trim()) {
    return { success: false, error: 'A prompt is required because it is what the agent starts with' };
  }
  if (!Number.isInteger(input.projectId) || input.projectId <= 0) {
    return { success: false, error: 'A project is required' };
  }
  if (input.id !== undefined && !input.id.trim()) {
    return { success: false, error: 'Schedule id must be a non-empty string' };
  }

  if (input.kind === 'interval') {
    if (!Number.isInteger(input.intervalMinutes) || (input.intervalMinutes ?? 0) < MIN_INTERVAL_MINUTES) {
      return { success: false, error: `The shortest interval is ${MIN_INTERVAL_MINUTES} minutes` };
    }
  } else if (input.kind === 'daily' || input.kind === 'weekly') {
    if (!parseTimeOfDay(input.timeOfDay)) {
      return { success: false, error: 'A valid time of day is required, as HH:MM' };
    }
    if (input.kind === 'weekly' && (!Number.isInteger(input.weekday) || (input.weekday ?? -1) < 0 || (input.weekday ?? 7) > 6)) {
      return { success: false, error: 'A weekday is required' };
    }
  } else {
    return { success: false, error: 'Schedule kind must be interval, daily, or weekly' };
  }

  return { success: true, data: input };
}
