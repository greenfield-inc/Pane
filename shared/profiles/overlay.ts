/**
 * Overlays: a profile that says `extends: <name>@<range>` holds only its changes to an
 * installed profile, so the base's updates keep reaching it. Merging works on the parsed
 * files; the validator then checks the merged result.
 */

import { boundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../validation/boundaryDecoder';

function asMap(value: JsonValue | undefined): JsonObject | undefined {
  return decodeOptionalBoundary(value, boundary.jsonObject);
}

export interface ProfileExtends {
  name: string;
  range: string;
}

/** Reads `greenfield@^1.0` (or a bare `greenfield`, meaning any version). */
export function parseExtends(value: string): ProfileExtends | undefined {
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)(?:@(.+))?$/u.exec(value.trim());
  if (!match) return undefined;
  return { name: match[1], range: (match[2] ?? '*').trim() };
}

type Version = [number, number, number];

function parseVersion(value: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compare(a: Version, b: Version): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** A partial version (`1`, `1.2`, `1.x`) as its numbers, with how many were given. */
function parsePartial(value: string): { parts: Version; given: number } | undefined {
  const pieces = value.split('.');
  if (pieces.length > 3) return undefined;
  const parts: Version = [0, 0, 0];
  let given = 0;
  for (const [index, piece] of pieces.entries()) {
    if (/^(?:x|X|\*)$/u.test(piece)) break;
    if (!/^\d+$/u.test(piece)) return undefined;
    parts[index] = Number(piece);
    given = index + 1;
  }
  return { parts, given };
}

/**
 * Whether `version` is in an npm-style `range`: `*`, an exact or partial version
 * (`1.2.3`, `1.2`, `1.x`), `^…`, `~…`, or one comparison (`>=1.0.0`, `<2`, …).
 */
export function satisfiesRange(version: string, range: string): boolean {
  const target = parseVersion(version);
  if (!target) return false;
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*' || trimmed.toLowerCase() === 'x') return true;
  const comparison = /^(>=|<=|>|<|=)\s*(.+)$/u.exec(trimmed);
  if (comparison) {
    const bound = parsePartial(comparison[2]);
    if (!bound) return false;
    const order = compare(target, bound.parts);
    switch (comparison[1]) {
      case '>=': return order >= 0;
      case '<=': return order <= 0;
      case '>': return order > 0;
      case '<': return order < 0;
      default: return order === 0;
    }
  }
  const operator = trimmed[0] === '^' || trimmed[0] === '~' ? trimmed[0] : '';
  const bound = parsePartial(trimmed.slice(operator.length));
  if (!bound || bound.given === 0) return bound?.given === 0;
  const lower = bound.parts;
  let upper: Version;
  if (operator === '^') {
    const firstNonZero = lower[0] !== 0 || bound.given === 1 ? 0 : lower[1] !== 0 || bound.given === 2 ? 1 : 2;
    upper = [0, 0, 0];
    for (let index = 0; index < firstNonZero; index += 1) upper[index] = lower[index];
    upper[firstNonZero] = lower[firstNonZero] + 1;
  } else if (operator === '~' && bound.given >= 2) {
    upper = [lower[0], lower[1] + 1, 0];
  } else if (bound.given === 3) {
    return compare(target, lower) === 0;
  } else {
    upper = bound.given === 1 ? [lower[0] + 1, 0, 0] : [lower[0], lower[1] + 1, 0];
  }
  return compare(target, lower) >= 0 && compare(target, upper) < 0;
}

type MergeEntry = (baseValue: JsonValue, overlayValue: JsonValue) => JsonValue;

/** Merges one keyed section: each key's value from the overlay replaces (or, `null`, removes) the base's. */
function mergeKeyed(base: JsonValue | undefined, overlay: JsonValue, mergeEntry: MergeEntry): JsonValue {
  const baseMap = asMap(base);
  const overlayMap = asMap(overlay);
  if (!baseMap || !overlayMap) return overlay;
  const merged: JsonObject = { ...baseMap };
  for (const [key, value] of Object.entries(overlayMap)) {
    if (value === null) delete merged[key];
    else merged[key] = key in baseMap ? mergeEntry(baseMap[key], value) : value;
  }
  return merged;
}

function shallowMerge(base: JsonValue, overlay: JsonValue): JsonValue {
  const baseMap = asMap(base);
  const overlayMap = asMap(overlay);
  return baseMap && overlayMap ? { ...baseMap, ...overlayMap } : overlay;
}

function replace(_base: JsonValue, overlay: JsonValue): JsonValue {
  return overlay;
}

/**
 * The overlay applied to its base: the header comes from the overlay; agents and steps
 * merge key by key (an overlay key replaces that key; `null` removes the agent or step);
 * samples merge per step and outcome; example runs and `start` are replaced whole.
 */
export function mergeOverlay(base: JsonObject, overlay: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (key === 'agents' || key === 'flow') merged[key] = mergeKeyed(base[key], value, shallowMerge);
    else if (key === 'samples') merged.samples = mergeKeyed(base.samples, value, (baseSteps, overlaySteps) => mergeKeyed(baseSteps, overlaySteps, replace));
    else if (key === 'runs') merged.runs = mergeKeyed(base.runs, value, replace);
    else if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}
