import type { JsonObject, JsonValue } from '../../../../shared/validation/boundaryDecoder';

/**
 * The contract every computer-use engine implements. Cua Driver (M1) and the
 * Codex runtime (M3) sit behind it; the script host and our layer only see this.
 */
type EngineId = 'cua-driver' | 'codex';

export interface EngineStatus {
  installed: boolean;
  version?: string;
  permissions: { accessibility?: boolean; screenRecording?: boolean };
  desktopSession: boolean;
  detail?: string;
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
}

export interface ComputerUseEngine {
  readonly id: EngineId;
  status(): Promise<EngineStatus>;
  /** Calls one raw engine tool, e.g. Cua's `get_window_state`. */
  call(tool: string, args: JsonObject): Promise<EngineResult>;
  stop(): Promise<void>;
}
