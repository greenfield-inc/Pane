import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HIGH_WATERMARK,
  LOW_WATERMARK,
  PAUSE_SAFETY_TIMEOUT,
  createFlowControlRecord,
  disposeFlowControlRecord,
  onAck,
  onPtyBytes,
} from './flowControl';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ptyHost flowControl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses after high watermark and resumes after low watermark ack', async () => {
    const record = createFlowControlRecord();
    const pause = vi.fn().mockResolvedValue(undefined);
    const resume = vi.fn();

    onPtyBytes(record, HIGH_WATERMARK + 1, pause, resume);

    expect(record.isPaused).toBe(true);
    expect(record.pauseRpcInFlight).toBe(true);
    expect(pause).toHaveBeenCalledTimes(1);

    await flushMicrotasks();

    expect(record.pauseRpcInFlight).toBe(false);
    expect(record.pauseSafetyTimer).not.toBeNull();

    onAck(record, HIGH_WATERMARK + 1 - LOW_WATERMARK, resume);

    expect(record.pendingBytes).toBe(LOW_WATERMARK);
    expect(record.isPaused).toBe(false);
    expect(record.pauseSafetyTimer).toBeNull();
    expect(resume).toHaveBeenCalledTimes(1);

    disposeFlowControlRecord(record);
  });

  it('force-resumes if a paused terminal receives no acks', async () => {
    const record = createFlowControlRecord();
    const pause = vi.fn().mockResolvedValue(undefined);
    const resume = vi.fn();

    onPtyBytes(record, HIGH_WATERMARK + 1, pause, resume);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(PAUSE_SAFETY_TIMEOUT);

    expect(record.isPaused).toBe(false);
    expect(record.pauseSafetyTimer).toBeNull();
    expect(resume).toHaveBeenCalledTimes(1);

    disposeFlowControlRecord(record);
  });

  it('does not arm safety timer until async pause resolves', async () => {
    const record = createFlowControlRecord();
    let resolvePause: (() => void) | undefined;
    const pause = vi.fn(() => new Promise<void>((resolve) => {
      resolvePause = resolve;
    }));
    const resume = vi.fn();

    onPtyBytes(record, HIGH_WATERMARK + 1, pause, resume);

    expect(record.isPaused).toBe(true);
    expect(record.pauseRpcInFlight).toBe(true);
    expect(record.pauseSafetyTimer).toBeNull();

    vi.advanceTimersByTime(PAUSE_SAFETY_TIMEOUT);
    expect(resume).not.toHaveBeenCalled();

    resolvePause?.();
    await flushMicrotasks();

    expect(record.pauseRpcInFlight).toBe(false);
    expect(record.pauseSafetyTimer).not.toBeNull();

    disposeFlowControlRecord(record);
  });

  it('forgives stale bytes on timeout but still pauses for a fresh full backlog', async () => {
    const record = createFlowControlRecord();
    const pause = vi.fn().mockResolvedValue(undefined);
    const resume = vi.fn();

    onPtyBytes(record, HIGH_WATERMARK + 1, pause, resume);
    await vi.advanceTimersByTimeAsync(PAUSE_SAFETY_TIMEOUT);
    onPtyBytes(record, 1, pause, resume);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(record.isPaused).toBe(false);

    onPtyBytes(record, HIGH_WATERMARK - 1, pause, resume);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(record.isPaused).toBe(true);
    await flushMicrotasks();
    onAck(record, HIGH_WATERMARK, resume);
    expect(resume).toHaveBeenCalledTimes(2);
    disposeFlowControlRecord(record);
  });
});
