import { describe, expect, it } from 'vitest';
import { validateScheduledRunInput } from './scheduleValidation';
import { decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { scheduledRunInputSchema } from '../../../shared/types/schedule';

const validInput = {
  name: 'Nightly sweep',
  projectId: 1,
  prompt: 'Review the latest changes',
  toolType: 'claude',
  enabled: true,
  kind: 'daily',
  timeOfDay: '03:30',
} as const;

describe('validateScheduledRunInput', () => {
  it('accepts each supported shape', () => {
    expect(validateScheduledRunInput(validInput).success).toBe(true);
    expect(validateScheduledRunInput({ ...validInput, kind: 'weekly', weekday: 2 }).success).toBe(true);
    expect(validateScheduledRunInput({ ...validInput, kind: 'interval', intervalMinutes: 15 }).success).toBe(true);
  });

  it.each([
    [{ ...validInput, timeOfDay: '99:99' }, 'valid time'],
    [{ ...validInput, kind: 'weekly', weekday: 7 }, 'weekday'],
    [{ ...validInput, kind: 'interval', intervalMinutes: 5.5 }, 'shortest interval'],
    [{ ...validInput, projectId: 1.5 }, 'project'],
  ])('rejects malformed daemon input %#', (input, message) => {
    const result = validateScheduledRunInput(decodeBoundary(input, scheduledRunInputSchema));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain(message);
  });

  it.each([
    { ...validInput, kind: 'monthly' },
    { ...validInput, toolType: 'shell' },
  ])('rejects unsupported boundary values %#', (input) => {
    expect(() => decodeBoundary(input, scheduledRunInputSchema)).toThrow();
  });
});
