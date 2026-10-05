import type { JsonObject, JsonValue } from '../../../../shared/validation/boundaryDecoder';

/**
 * The contract every computer-use engine implements. Cua Driver (M1) and the
 * Codex runtime (M3) sit behind it; the script host and our layer only see this.
 */
export type EngineId = 'cua-driver' | 'codex';

export interface EngineStatus {
  installed: boolean;
  version?: string;
  permissions: { accessibility?: boolean; screenRecording?: boolean };
  desktopSession: boolean;
  detail?: string;
  /** Set when Auto runs on Cua Driver: why the Codex runtime wasn't used. */
  fallbackReason?: string;
}

export interface EngineImage {
  mime: string;
  base64: string;
}

export interface EngineResult {
  ok: boolean;
  data?: JsonValue;
  error?: { code: string; message: string };
  images?: EngineImage[];
  /** Set by the daemon when it showed the user the foreground notice before this call. */
  notice?: string;
}

export interface ComputerUseEngine {
  readonly id: EngineId;
  status(): Promise<EngineStatus>;
  /** Calls one raw engine tool, e.g. Cua's `get_window_state`. */
  call(tool: string, args: JsonObject): Promise<EngineResult>;
  stop(): Promise<void>;
}
