import { describe, expect, it } from 'vitest';
import {
  encodePaneDaemonFrame,
  PaneDaemonFrameDecoder,
} from './socketFraming';
import {
  type PaneDaemonEventFrame,
  type PaneDaemonRequestFrame,
  type PaneDaemonResponseFrame,
} from '../../../shared/types/daemon';
import { isDaemonOwnedChannel } from './daemonChannels';

describe('Pane daemon framing', () => {
  it('encodes frames as newline-delimited JSON', () => {
    const frame: PaneDaemonRequestFrame = {
      type: 'request',
      id: 42,
      channel: 'sessions:get-all',
      args: [],
    };

    expect(encodePaneDaemonFrame(frame)).toBe('{"type":"request","id":42,"channel":"sessions:get-all","args":[]}\n');
  });

  it('decodes frames split across multiple chunks', () => {
    const decoder = new PaneDaemonFrameDecoder();
    const frame: PaneDaemonEventFrame = {
      type: 'event',
      channel: 'session:created',
      args: [{ id: 'session-1' }],
    };

    const encoded = encodePaneDaemonFrame(frame);

    expect(decoder.push(encoded.slice(0, 12))).toEqual([]);
    expect(decoder.push(encoded.slice(12))).toEqual([frame]);
    expect(decoder.pendingBuffer()).toBe('');
  });

  it('preserves multibyte UTF-8 characters split across buffer chunks', () => {
    const decoder = new PaneDaemonFrameDecoder();
    const frame: PaneDaemonEventFrame = {
      type: 'event',
      channel: 'session:created',
      args: [{ id: 'session-1', label: 'Pane café 日本語' }],
    };

    const encodedBuffer = Buffer.from(encodePaneDaemonFrame(frame), 'utf8');
    const multibyteChar = Buffer.from('é', 'utf8');
    const splitIndex = encodedBuffer.indexOf(multibyteChar) + 1;
    expect(splitIndex).toBeGreaterThan(0);

    expect(decoder.push(encodedBuffer.subarray(0, splitIndex))).toEqual([]);
    expect(decoder.push(encodedBuffer.subarray(splitIndex))).toEqual([frame]);
    expect(decoder.pendingBuffer()).toBe('');
  });

  it('decodes multiple frames from a single chunk', () => {
    const decoder = new PaneDaemonFrameDecoder();
    const first: PaneDaemonRequestFrame = {
      type: 'request',
      id: 1,
      channel: 'projects:get-all',
      args: [],
    };
    const second: PaneDaemonResponseFrame = {
      type: 'response',
      id: 1,
      ok: true,
      result: [{ id: 7 }],
    };

    const frames = decoder.push(`${encodePaneDaemonFrame(first)}${encodePaneDaemonFrame(second)}`);

    expect(frames).toEqual([first, second]);
  });

  it('rejects invalid JSON frames', () => {
    const decoder = new PaneDaemonFrameDecoder();

    expect(() => decoder.push('{"type":"request"\n')).toThrow('Failed to parse Pane daemon frame');
  });

  it('rejects frames that do not match the Pane daemon protocol', () => {
    const decoder = new PaneDaemonFrameDecoder();

    expect(() => decoder.push('{"type":"request","id":"bad","channel":"sessions:get-all","args":[]}\n')).toThrow(
      'Failed to parse Pane daemon frame: frame does not match Pane daemon protocol',
    );
  });

  it('rejects incomplete trailing frames when finishing the stream', () => {
    const decoder = new PaneDaemonFrameDecoder();
    decoder.push('{"type":"request","id":1');

    expect(() => decoder.finish()).toThrow('Incomplete Pane daemon frame at end of stream');
  });
});

describe('Pane daemon shared protocol helpers', () => {
  it('classifies daemon-owned channels conservatively', () => {
    expect(isDaemonOwnedChannel('sessions:get-all')).toBe(true);
    expect(isDaemonOwnedChannel('projects:create')).toBe(true);
    expect(isDaemonOwnedChannel('git:commit')).toBe(true);
    expect(isDaemonOwnedChannel('file:write')).toBe(true);
    expect(isDaemonOwnedChannel('file:showInFolder')).toBe(false);
    expect(isDaemonOwnedChannel('sessions:open-ide')).toBe(false);
    // Active-session hints also prioritize polling on remote daemons.
    expect(isDaemonOwnedChannel('sessions:set-active-session')).toBe(true);
    expect(isDaemonOwnedChannel('terminal:clipboard-paste-image')).toBe(false);
    expect(isDaemonOwnedChannel('openExternal')).toBe(false);
  });
});
