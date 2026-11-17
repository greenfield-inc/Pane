import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import yaml from 'js-yaml';
import { reasonOf } from '../../../../shared/paneError';
import { mergeOverlay, parseExtends, satisfiesRange } from '../../../../shared/profiles/overlay';
import { validateProfile } from '../../../../shared/profiles/validateProfile';
import type { LoadedProfile, ProfileOrigin, ProfileProblem } from '../../../../shared/types/profiles';
import { boundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';

const PROFILE_FILE_SUFFIX = '.profile.yaml';

/** One profile file and where its `reads` files live. */
export interface ProfileSource {
  file: string;
  origin: ProfileOrigin;
  /** The folder an agent's `reads` resolve in (`instructions/<id>.md` or `<id>.md`); defaults to the file's folder. */
  filesRoot?: string;
}

export interface ProfileLoadOptions {
  /** Whether a skill is installed; skill names go unchecked without it. */
  skillExists?: (name: string) => boolean;
}

/** Every `*.profile.yaml` directly in `dir`, sorted; none when the folder doesn't exist. */
export function findProfileFiles(dir: string, origin: ProfileOrigin): ProfileSource[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(PROFILE_FILE_SUFFIX))
    .sort()
    .map((entry) => ({ file: join(dir, entry), origin }));
}

interface ParsedSource {
  source: ProfileSource;
  /** The file's own name for itself, else its file name. */
  name: string;
  raw?: JsonObject;
  errors: ProfileProblem[];
}

function readSource(source: ProfileSource): ParsedSource {
  const fallbackName = basename(source.file, PROFILE_FILE_SUFFIX);
  let text: string;
  try {
    text = readFileSync(source.file, 'utf8');
  } catch (error) {
    return { source, name: fallbackName, errors: [{ code: 'PROFILE_UNREADABLE', message: `Pane couldn't read ${source.file}: ${reasonOf(error)}.`, fix: 'Check the file exists and Pane may read it.' }] };
  }
  let parsed: unknown;
  try {
    // CORE_SCHEMA: plain YAML values only (no timestamps or custom tags), so the result is JSON.
    parsed = yaml.load(text, { schema: yaml.CORE_SCHEMA, filename: source.file });
  } catch (error) {
    return { source, name: fallbackName, errors: [{ code: 'PROFILE_YAML', message: `${basename(source.file)} is not valid YAML: ${reasonOf(error)}.`, fix: 'Fix the YAML at the line named, then reload.' }] };
  }
  const raw = decodeOptionalBoundary(parsed, boundary.jsonObject);
  if (!raw) {
    return { source, name: fallbackName, errors: [{ code: 'PROFILE_NOT_A_MAPPING', message: `${basename(source.file)} is not a profile: its top level is not a set of keys.`, fix: 'Start the file with "format: pane-profile/1", then name, version and agents.' }] };
  }
  const name = decodeOptionalBoundary(raw.name, boundary.nonEmptyString)?.trim() ?? fallbackName;
  return { source, name, raw, errors: [] };
}

function readExistsIn(roots: string[]): (id: string) => boolean {
  return (id) => roots.some((root) => existsSync(join(root, 'instructions', `${id}.md`)) || existsSync(join(root, `${id}.md`)));
}

function filesRootOf(source: ProfileSource): string {
  return source.filesRoot ?? dirname(source.file);
}

function toLoaded(parsed: ParsedSource, merged: JsonObject | undefined, roots: string[], options: ProfileLoadOptions, extraErrors: ProfileProblem[]): LoadedProfile {
  const loaded: LoadedProfile = { name: parsed.name, origin: parsed.source.origin, file: parsed.source.file, valid: false, launchable: false, teamOnly: false, errors: [...parsed.errors, ...extraErrors] };
  if (!merged) return loaded;
  const validation = validateProfile(merged, { readExists: readExistsIn(roots), skillExists: options.skillExists });
  loaded.errors.push(...validation.errors);
  const profile = validation.profile;
  if (!profile) return loaded;
  loaded.profile = profile;
  if (profile.version) loaded.version = profile.version;
  if (profile.title) loaded.title = profile.title;
  loaded.valid = loaded.errors.length === 0;
  loaded.teamOnly = !profile.flow;
  loaded.launchable = loaded.valid && !loaded.teamOnly;
  return loaded;
}

/**
 * Reads every profile, applies overlays to the profiles they extend, and validates each
 * one. Never throws for a bad file: it comes back invalid with its errors. Names are
 * unique; when two files share one, the first source listed keeps it.
 */
export function loadProfiles(sources: ProfileSource[], options: ProfileLoadOptions = {}): LoadedProfile[] {
  const parsed = sources.map(readSource);
  const bases = new Map<string, ParsedSource>();
  const seen = new Set<string>();
  const results: LoadedProfile[] = [];

  for (const entry of parsed) {
    const duplicate = seen.has(entry.name);
    seen.add(entry.name);
    if (!entry.raw || entry.raw.extends !== undefined || duplicate) continue;
    bases.set(entry.name, entry);
  }
  const claimed = new Set<string>();
  for (const entry of parsed) {
    if (claimed.has(entry.name)) {
      results.push(toLoaded(entry, undefined, [], options, [{ code: 'PROFILE_DUPLICATE', message: `Another profile is already named "${entry.name}" (${entry.source.file} is skipped).`, fix: `Rename this one, or make it an overlay with "extends: ${entry.name}@<range>" to change the other.` }]));
      continue;
    }
    claimed.add(entry.name);
    const raw = entry.raw;
    const extendsText = raw ? decodeOptionalBoundary(raw.extends, boundary.string) : undefined;
    if (!raw || raw.extends === undefined) {
      results.push(toLoaded(entry, raw, [filesRootOf(entry.source)], options, []));
      continue;
    }
    const target = extendsText ? parseExtends(extendsText) : undefined;
    if (!target) {
      results.push(toLoaded(entry, undefined, [], options, [{ code: 'EXTENDS_SHAPE', message: `"extends: ${String(raw.extends)}" is not <name>@<version range>.`, fix: 'Write it as "extends: greenfield@^1.0".' }]));
      continue;
    }
    const base = bases.get(target.name);
    const baseVersion = base?.raw ? decodeOptionalBoundary(base.raw.version, boundary.string) : undefined;
    if (!base?.raw) {
      results.push(toLoaded(entry, undefined, [], options, [{ code: 'EXTENDS_MISSING', message: `This profile extends ${target.name}, which is not installed.`, fix: `Install ${target.name}, or remove "extends:".` }]));
      continue;
    }
    if (!baseVersion || !satisfiesRange(baseVersion, target.range)) {
      results.push(toLoaded(entry, undefined, [], options, [{ code: 'EXTENDS_VERSION', message: `This profile extends ${target.name}@${target.range}, but ${target.name} ${baseVersion ?? '(no version)'} is installed.`, fix: `Widen the range in "extends:" to include ${baseVersion ?? 'the installed version'}.` }]));
      continue;
    }
    results.push(toLoaded(entry, mergeOverlay(base.raw, raw), [filesRootOf(entry.source), filesRootOf(base.source)], options, []));
  }
  return results;
}
