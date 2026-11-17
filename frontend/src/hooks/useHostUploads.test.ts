import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';
import { attachTerminalPaste, cancelPanelUploads, uploadToTerminal } from './useHostUploads';

/**
 * A host that takes chunks and holds each commit until the test lets it land,
 * as a slow upload does; it records the channels called.
 */
function heldHost() {
  const calls: string[] = [];
  const held: Array<() => void> = [];
  const received = new Map<string, number>();
  const invoke = async (channel: string, args: JsonValue[]): Promise<JsonValue | undefined> => {
    calls.push(channel);
    // SAFETY: upload-start sends an UploadStart object; every other upload channel starts with the upload id.
    const uploadId = String(channel === 'terminal:upload-start' ? (args[0] as { uploadId: string }).uploadId : args[0]);
    if (channel === 'terminal:upload-start') return { receivedBytes: received.get(uploadId) ?? 0 };
    if (channel === 'terminal:upload-chunk') {
      received.set(uploadId, (received.get(uploadId) ?? 0) + atob(String(args[2])).length);
      return { receivedBytes: received.get(uploadId) ?? 0 };
    }
    if (channel === 'terminal:upload-commit') {
      await new Promise<void>(resolve => held.push(resolve));
      return { filePath: `/host/files/${uploadId}` };
    }
    return undefined;
  };
  return { invoke, calls, held };
}

const file = (name: string) => new File(['bytes'], name);

describe('terminal uploads', () => {
  it('keeps copying while another Pane is shown, and pastes the path when the terminal is back', async () => {
    const host = heldHost();
    const pasted: string[] = [];
    const detach = attachTerminalPaste('panel-a', text => pasted.push(text));
    const running = uploadToTerminal('panel-a', [file('movie.mov')], { invoke: host.invoke, sessionId: 's1' });
    await vi.waitFor(() => expect(host.held).toHaveLength(1));

    // Switching Panes unmounts the terminal; the copy lands meanwhile.
    detach();
    host.held[0]?.();
    await running;
    expect(pasted).toEqual([]);

    attachTerminalPaste('panel-a', text => pasted.push(text));
    expect(pasted).toEqual([expect.stringMatching(/^\/host\/files\/desktop-\w+\n$/)]);
  });

  it('stops the copies when the panel is closed, and sends no file after it', async () => {
    const host = heldHost();
    const pasted: string[] = [];
    attachTerminalPaste('panel-b', text => pasted.push(text));
    const running = uploadToTerminal('panel-b', [file('one.bin'), file('two.bin')], { invoke: host.invoke, sessionId: 's1' });
    await vi.waitFor(() => expect(host.held).toHaveLength(1));

    cancelPanelUploads('panel-b');
    host.held[0]?.();
    await running;

    expect(host.calls.filter(channel => channel === 'terminal:upload-start')).toHaveLength(1);
    expect(pasted).toEqual([]);
  });
});
