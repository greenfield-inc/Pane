import { spawn as spawnProcess } from 'child_process';
import type { EventEmitter } from 'events';
import { reasonOf } from '../../../shared/paneError';

/**
 * Electron's keep-awake on Windows is an execution-required request, which does
 * not stop idle sleep on Modern Standby laptops (#1041), and Electron exposes no
 * system-required request or input injection. A hidden PowerShell child holds
 * them instead. Windows releases a process's power request when it exits, and
 * the child exits when its stdin closes, so nothing it holds outlives Pane.
 *
 * - `system-required` (plugged in): PowerSetRequest(PowerRequestSystemRequired).
 * - `press-f15` (battery): an F15 keypress on each `f15` line from Pane, which
 *   resets the idle and lock timers. Modern Standby ends system requests on
 *   battery, so this is what keeps Windows from locking and sleeping there.
 */
export type WindowsKeepAwakeMode = 'system-required' | 'press-f15';

export interface WindowsKeepAwakeHelperHandle {
  stop(): void;
}

export interface WindowsKeepAwakeHelper {
  start(mode: WindowsKeepAwakeMode): WindowsKeepAwakeHelperHandle;
}

export interface HelperProcess extends EventEmitter {
  stdout: EventEmitter | null;
  stdin: { write(chunk: string): void; end(): void; on(event: 'error', listener: (error: Error) => void): void } | null;
  kill(): boolean;
}

interface HelperLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** Under a one-minute lock or sleep timeout, the shortest Windows offers. */
export const F15_INTERVAL_MS = 59_000;
/** PowerShell start plus Add-Type compilation takes a few seconds on a cold machine. */
export const HELPER_READY_TIMEOUT_MS = 15_000;
const KEEP_AWAKE_REASON = 'Pane: agent sessions are active';

const LOST = {
  'system-required': "Windows system-awake request not held; Electron's request still is, so this PC may still idle-sleep.",
  'press-f15': "Windows auto-lock not prevented; Electron's screen-on request still is, so this PC may still lock.",
} satisfies Record<WindowsKeepAwakeMode, string>;

const NEXT =
  'Next: allow powershell.exe to run Add-Type (Constrained Language Mode, AppLocker or antivirus can block it), then restart Pane.';

const NO_OP_HANDLE: WindowsKeepAwakeHelperHandle = { stop: () => {} };

export function createWindowsKeepAwakeHelper({
  spawn = spawnHelperProcess,
  logger = console,
}: {
  spawn?: (mode: WindowsKeepAwakeMode) => HelperProcess;
  logger?: HelperLogger;
} = {}): WindowsKeepAwakeHelper {
  // A helper that could not start once (no PowerShell, Add-Type blocked) will
  // not start the next time either, so Pane warns once and stops trying.
  let unavailable = false;

  return {
    start(mode) {
      if (unavailable) return NO_OP_HANDLE;

      let child: HelperProcess;
      try {
        child = spawn(mode);
      } catch (error) {
        unavailable = true;
        logger.warn(`[PowerSave] ${LOST[mode]} powershell.exe did not start: ${reasonOf(error)}. ${NEXT}`);
        return NO_OP_HANDLE;
      }

      let ready = false;
      let stopped = false;
      let failureReason: string | null = null;
      let pressTimer: NodeJS.Timeout | null = null;
      let stdoutBuffer = '';

      const clearTimers = (): void => {
        clearTimeout(readyTimer);
        if (pressTimer) clearInterval(pressTimer);
        pressTimer = null;
      };
      const pressF15 = (): void => {
        child.stdin?.write('f15\n');
      };
      const fail = (reason: string): void => {
        if (stopped) return;
        stopped = true;
        clearTimers();
        child.kill();
        if (!ready) unavailable = true;
        const restart = ready ? 'Pane starts it again on the next power change or wake.' : NEXT;
        logger.warn(`[PowerSave] ${LOST[mode]} The keep-awake helper (powershell.exe) ${reason}. ${restart}`);
      };

      const readyTimer = setTimeout(
        () => fail(`did not report ready within ${HELPER_READY_TIMEOUT_MS / 1000} s`),
        HELPER_READY_TIMEOUT_MS,
      );

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdoutBuffer += chunk.toString();
        let newline = stdoutBuffer.indexOf('\n');
        while (newline !== -1) {
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          newline = stdoutBuffer.indexOf('\n');
          if (line === 'ready' && !ready && !stopped) {
            ready = true;
            clearTimeout(readyTimer);
            logger.info(`[PowerSave] Windows keep-awake helper holds ${mode}.`);
            if (mode === 'press-f15') {
              pressF15();
              pressTimer = setInterval(pressF15, F15_INTERVAL_MS);
            }
          } else if (line.startsWith('error ')) {
            failureReason = line.slice('error '.length);
          }
        }
      });
      child.on('error', (error: Error) => fail(`could not run: ${reasonOf(error)}`));
      // A write to a helper that just exited fails with EPIPE on the stream,
      // not on the process; unhandled, it would crash Pane's main process.
      child.stdin?.on('error', (error: Error) => fail(`stopped reading its input: ${reasonOf(error)}`));
      child.on('exit', (code: number | null) => {
        if (failureReason) fail(`failed: ${failureReason}`);
        else fail(`exited with code ${code ?? 'none'}`);
      });

      return {
        stop() {
          if (stopped) return;
          stopped = true;
          clearTimers();
          child.stdin?.end();
          child.kill();
        },
      };
    },
  };
}

/** Starts the hidden helper. Exported for the Windows smoke test. */
export function spawnHelperProcess(mode: WindowsKeepAwakeMode): HelperProcess {
  // -EncodedCommand sidesteps execution policy and command-line quoting.
  const script = `$mode = '${mode}'\n$reason = '${KEEP_AWAKE_REASON}'\n${HELPER_SCRIPT}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}

// Prints `ready` once the request is held (or input can be sent), then acts on
// stdin lines until Pane closes it. Exit releases the power request.
const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class PaneKeepAwake {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct REASON_CONTEXT {
    public uint Version;
    public uint Flags;
    public string SimpleReasonString;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct INPUT {
    public uint type;
    public INPUTUNION u;
  }

  const uint POWER_REQUEST_CONTEXT_VERSION = 0;
  const uint POWER_REQUEST_CONTEXT_SIMPLE_STRING = 1;
  const int PowerRequestSystemRequired = 1;
  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 2;
  const ushort VK_F15 = 0x7E;

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr PowerCreateRequest(ref REASON_CONTEXT context);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool PowerSetRequest(IntPtr request, int requestType);

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint count, INPUT[] inputs, int size);

  static IntPtr request = IntPtr.Zero;

  public static void HoldSystemRequired(string reason) {
    REASON_CONTEXT context = new REASON_CONTEXT();
    context.Version = POWER_REQUEST_CONTEXT_VERSION;
    context.Flags = POWER_REQUEST_CONTEXT_SIMPLE_STRING;
    context.SimpleReasonString = reason;
    request = PowerCreateRequest(ref context);
    if (request == IntPtr.Zero || request == new IntPtr(-1)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "PowerCreateRequest failed");
    }
    if (!PowerSetRequest(request, PowerRequestSystemRequired)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "PowerSetRequest failed");
    }
  }

  public static uint PressF15() {
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].u.ki.wVk = VK_F15;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].u.ki.wVk = VK_F15;
    inputs[1].u.ki.dwFlags = KEYEVENTF_KEYUP;
    return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
  if ($mode -eq 'system-required') { [PaneKeepAwake]::HoldSystemRequired($reason) }
  [Console]::Out.WriteLine('ready')
  [Console]::Out.Flush()
} catch {
  [Console]::Out.WriteLine('error ' + ($_.Exception.Message -replace '\s+', ' '))
  [Console]::Out.Flush()
  exit 1
}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($mode -eq 'press-f15' -and $line -eq 'f15') { [void][PaneKeepAwake]::PressF15() }
}
`;
