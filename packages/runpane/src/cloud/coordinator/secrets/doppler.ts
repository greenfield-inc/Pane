import { boundary, decodeBoundary } from '../../../boundaryDecoder';
import type { FetchLike } from '../../githubTransport';

/**
 * Reads one Doppler config's secrets with a read-only service token (scoped to that config by
 * Doppler itself), over Doppler's REST API: no Doppler CLI on the coordinator. Values stay in memory
 * for the length of one request; errors carry Doppler's message, never a token or a value.
 */

const TIMEOUT_MS = 20_000;

export class DopplerError extends Error {
  override name = 'DopplerError';

  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const downloadSchema = boundary.jsonObject;
const errorSchema = boundary.object({ messages: boundary.optional(boundary.array(boundary.string)) });

export interface DopplerApi {
  /**
   * Every secret in `project/config`, name to computed value. A service token only reads its own
   * config (Doppler answers 400 for any other), so naming it also checks the token is the right one.
   */
  download(token: string, project: string, config: string): Promise<Map<string, string>>;
}

export function createDopplerApi(apiBaseUrl: string, fetchImpl: FetchLike = fetch): DopplerApi {
  const base = apiBaseUrl.replace(/\/+$/u, '');
  return {
    async download(token, project, config) {
      const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'runpane-cloud-coordinator' });
      let response;
      try {
        const query = new URLSearchParams({ format: 'json', project, config });
        response = await fetchImpl(`${base}/v3/configs/config/secrets/download?${query.toString()}`, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (cause) {
        throw new DopplerError(`Doppler could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`, 0);
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (response.status < 200 || response.status >= 300) {
        let message = `HTTP ${response.status}`;
        try {
          message = decodeBoundary(parsed, errorSchema).messages?.join('; ') || message;
        } catch {
          // keep the status line
        }
        throw new DopplerError(`Doppler answered ${response.status}: ${message.slice(0, 300)}`, response.status);
      }
      try {
        // Doppler computes references before download: every value in its JSON format is a string.
        return new Map(Object.entries(decodeBoundary(parsed, downloadSchema)).map(([name, value]) => [name, decodeBoundary(value, boundary.string)]));
      } catch {
        throw new DopplerError('Doppler answered with something that is not a JSON object of string secrets', response.status);
      }
    },
  };
}
