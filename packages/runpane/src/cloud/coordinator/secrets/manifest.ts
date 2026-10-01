import { boundary, decodeBoundary } from '../../../boundaryDecoder';

/**
 * The per-repository secrets manifest, `.runpane/secrets.json`, committed to the repository a cloud
 * Session works on. It says which Doppler project/configs, and which names from each, the Session's
 * `doppler` stand-in gets. It holds names only, never values, so it is safe to commit.
 *
 *   {
 *     "version": 1,
 *     "doppler": [
 *       { "project": "my-app", "config": "dev", "names": "all" },
 *       { "project": "my-app", "config": "dev_personal", "names": ["OPENROUTER_API_KEY", "R2_*"] }
 *     ]
 *   }
 *
 * The first entry is what `doppler run` uses when no --project/--config is given. `*` in a name
 * matches any run of characters. The coordinator's secrets policy still applies on top of it.
 */

export const MANIFEST_PATH = '.runpane/secrets.json';

const MAX_ENTRIES = 20;
const MAX_NAMES = 500;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const NAME_OR_GLOB_PATTERN = /^[A-Za-z_*][A-Za-z0-9_*]{0,127}$/u;

export interface ManifestEntry {
  project: string;
  config: string;
  /** 'all', or names and `*` patterns. */
  names: 'all' | string[];
}

export interface SecretsManifest {
  entries: ManifestEntry[];
}

export class ManifestError extends Error {
  override name = 'ManifestError';
}

const manifestSchema = boundary.object({
  version: boundary.literal(1),
  doppler: boundary.array(boundary.object({
    project: boundary.nonEmptyString,
    config: boundary.nonEmptyString,
    names: boundary.union(boundary.literal('all'), boundary.array(boundary.nonEmptyString)),
  })),
});

/** Parses and checks a manifest's text; every problem is a ManifestError naming what to fix. */
export function parseManifest(text: string): SecretsManifest {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ManifestError(`${MANIFEST_PATH} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  let decoded;
  try {
    decoded = decodeBoundary(raw, manifestSchema);
  } catch (cause) {
    throw new ManifestError(`${MANIFEST_PATH} does not match {"version": 1, "doppler": [{"project", "config", "names": "all" | [...]}]}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (decoded.doppler.length === 0) throw new ManifestError(`${MANIFEST_PATH} lists no Doppler configs.`);
  if (decoded.doppler.length > MAX_ENTRIES) throw new ManifestError(`${MANIFEST_PATH} lists more than ${MAX_ENTRIES} Doppler configs.`);
  const seen = new Set<string>();
  const entries = decoded.doppler.map((entry): ManifestEntry => {
    for (const [what, value] of [['project', entry.project], ['config', entry.config]] as const) {
      if (!SLUG_PATTERN.test(value)) throw new ManifestError(`${MANIFEST_PATH}: ${what} "${value.slice(0, 80)}" is not a Doppler ${what} name.`);
    }
    const key = `${entry.project}/${entry.config}`;
    if (seen.has(key)) throw new ManifestError(`${MANIFEST_PATH} lists ${key} twice.`);
    seen.add(key);
    if (entry.names === 'all') return { project: entry.project, config: entry.config, names: 'all' };
    if (entry.names.length === 0) throw new ManifestError(`${MANIFEST_PATH}: ${key} has an empty names list (use "all", or drop the entry).`);
    if (entry.names.length > MAX_NAMES) throw new ManifestError(`${MANIFEST_PATH}: ${key} lists more than ${MAX_NAMES} names.`);
    const bad = entry.names.find((name) => !NAME_OR_GLOB_PATTERN.test(name));
    if (bad !== undefined) throw new ManifestError(`${MANIFEST_PATH}: ${key}: "${bad.slice(0, 80)}" is not a variable name or * pattern.`);
    return { project: entry.project, config: entry.config, names: [...new Set(entry.names)] };
  });
  return { entries };
}
