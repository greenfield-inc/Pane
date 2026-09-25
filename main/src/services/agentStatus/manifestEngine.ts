/**
 * Pure, side-effect-free agent-status detection engine.
 *
 * Evaluates a per-agent {@link AgentManifest} of priority-ordered rules against a
 * live terminal snapshot (screen text + OSC title/progress) and returns the
 * winning {@link AgentState}. The engine is intentionally dependency-free and
 * deterministic so it stays trivially unit-testable; all terminal reads and IPC
 * happen in the caller (see agentStatusMonitor).
 *
 * The rule/region semantics mirror a small, well-tested subset of screen-manifest
 * detection: regions carve the snapshot, and gates combine `contains` / `regex` /
 * `lineRegex` / `all` / `any` / `not` matchers. Highest priority wins; ties keep
 * the earlier rule.
 */

import type {
  AgentDetectionInput,
  AgentDetectionResult,
  AgentState,
} from '../../../../shared/types/agentStatus';

/** A boolean matcher over a region of text. Nestable via all/any/not. */
interface Gate {
  /** Case-insensitive substrings; all must be present. */
  contains?: string[];
  /** Patterns; all must match the region text. */
  regex?: RegExp[];
  /** Patterns; each must match at least one line of the region. */
  lineRegex?: RegExp[];
  /** All nested gates must match. */
  all?: Gate[];
  /** At least one nested gate must match (when non-empty). */
  any?: Gate[];
  /** No nested gate may match. */
  not?: Gate[];
}

/** A single manifest rule: a gate plus the state it implies when matched. */
export interface ManifestRule extends Gate {
  id: string;
  state: AgentState;
  priority: number;
  /** Region spec, e.g. `osc_title`, `whole_recent`, `bottom_non_empty_lines(3)`. */
  region: string;
  /** When matched, hold the previously known state instead of adopting `state`. */
  skipStateUpdate?: boolean;
  visibleBlocker?: boolean;
  visibleWorking?: boolean;
  visibleIdle?: boolean;
}

export interface AgentManifest {
  id: string;
  rules: ManifestRule[];
}

// ---------------------------------------------------------------------------
// Region extraction
// ---------------------------------------------------------------------------

function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  let ruleChars = 0;
  for (const ch of trimmed) {
    if (ch === '─') ruleChars += 1;
    else break;
  }
  if (ruleChars === 0) return false;
  const suffix = Array.from(trimmed).slice(ruleChars).join('').trimStart();
  return suffix.length === 0 || ruleChars >= 3;
}

function isCodexPromptLine(line: string): boolean {
  return line === '›' || line.startsWith('› ');
}

/** Join lines [start..end) preserving the original newline layout. */
function joinLines(lines: string[], start: number, end: number = lines.length): string {
  return lines.slice(start, end).join('\n');
}

function bottomNonEmptyLines(content: string, count: number): string {
  const lines = content.split('\n');
  let seen = 0;
  let startIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().length > 0) {
      seen += 1;
      startIndex = i;
      if (seen === count) break;
    }
  }
  if (startIndex === -1) return '';
  return joinLines(lines, startIndex);
}

function afterLastHorizontalRule(content: string): string {
  const lines = content.split('\n');
  let lastRuleIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isHorizontalRule(lines[i])) lastRuleIndex = i;
  }
  if (lastRuleIndex === -1) return content;
  return joinLines(lines, lastRuleIndex + 1);
}

function afterLastPromptMarker(content: string): string {
  const lines = content.split('\n');
  let index = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isCodexPromptLine(lines[i])) {
      index = i;
      break;
    }
  }
  if (index === -1) return content;
  return joinLines(lines, index + 1);
}

/** Index of the prompt box's top border: the 2nd horizontal rule from the bottom. */
function promptBoxTopBorderIndex(lines: string[]): number {
  let borderCount = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isHorizontalRule(lines[i])) {
      borderCount += 1;
      if (borderCount === 2) return i;
    }
  }
  return -1;
}

function promptBoxBody(content: string): string {
  const lines = content.split('\n');
  const top = promptBoxTopBorderIndex(lines);
  if (top === -1) return '';
  let end = lines.length;
  for (let i = top + 1; i < lines.length; i += 1) {
    if (isHorizontalRule(lines[i])) {
      end = i;
      break;
    }
  }
  return joinLines(lines, top + 1, end);
}

function regionCount(spec: string, name: string): number | null {
  const prefix = `${name}(`;
  if (!spec.startsWith(prefix) || !spec.endsWith(')')) return null;
  const inner = spec.slice(prefix.length, -1);
  if (!/^\d+$/.test(inner)) return null;
  return Number.parseInt(inner, 10);
}

/** Extract the text a rule's `region` spec points at. Unknown specs → "". */
export function extractRegion(input: AgentDetectionInput, spec: string): string {
  const trimmed = spec.trim();
  switch (trimmed) {
    case 'osc_title':
      return input.oscTitle;
    case 'osc_progress':
      return input.oscProgress;
    case 'whole_recent':
      return input.screen;
    case 'after_last_horizontal_rule':
      return afterLastHorizontalRule(input.screen);
    case 'after_last_prompt_marker':
      return afterLastPromptMarker(input.screen);
    case 'prompt_box_body':
      return promptBoxBody(input.screen);
    default: {
      const nonEmpty = regionCount(trimmed, 'bottom_non_empty_lines');
      if (nonEmpty !== null) return bottomNonEmptyLines(input.screen, nonEmpty);
      return '';
    }
  }
}

// ---------------------------------------------------------------------------
// Gate / rule matching
// ---------------------------------------------------------------------------

function gateMatches(gate: Gate, text: string, lowerText: string): boolean {
  if (gate.contains && !gate.contains.every((needle) => lowerText.includes(needle.toLowerCase()))) {
    return false;
  }
  if (gate.regex && !gate.regex.every((re) => re.test(text))) {
    return false;
  }
  if (gate.lineRegex) {
    const lines = text.split('\n');
    if (!gate.lineRegex.every((re) => lines.some((line) => re.test(line)))) {
      return false;
    }
  }
  if (gate.all && !gate.all.every((nested) => gateMatches(nested, text, lowerText))) {
    return false;
  }
  if (gate.any && gate.any.length > 0 && !gate.any.some((nested) => gateMatches(nested, text, lowerText))) {
    return false;
  }
  if (gate.not && gate.not.some((nested) => gateMatches(nested, text, lowerText))) {
    return false;
  }
  return true;
}

/** True when a rule's gate matches the given region text. */
export function ruleMatches(rule: ManifestRule, text: string): boolean {
  return gateMatches(rule, text, text.toLowerCase());
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const IDLE_FALLBACK: AgentDetectionResult = {
  state: 'idle',
  visibleBlocker: false,
  visibleWorking: false,
  visibleIdle: false,
  skipStateUpdate: false,
  matchedRuleId: null,
};

const rulesByPriority = new WeakMap<AgentManifest, ManifestRule[]>();

/** Rules highest priority first; the stable sort keeps ties in manifest order. */
function sortedRules(manifest: AgentManifest): ManifestRule[] {
  let rules = rulesByPriority.get(manifest);
  if (!rules) {
    rules = [...manifest.rules].sort((a, b) => b.priority - a.priority);
    rulesByPriority.set(manifest, rules);
  }
  return rules;
}

/**
 * Evaluate a manifest against a snapshot. Returns the highest-priority matching
 * rule's state (ties resolved to the earlier rule); with no match, a known agent
 * falls back to `idle`. Rules are tried highest priority first and the first
 * match wins, so a cheap OSC-title rule settles a busy agent without reading the
 * screen.
 */
export function detectAgentState(
  manifest: AgentManifest,
  input: AgentDetectionInput,
): AgentDetectionResult {
  const winner = sortedRules(manifest).find((rule) => ruleMatches(rule, extractRegion(input, rule.region)));

  if (winner === undefined) return { ...IDLE_FALLBACK };

  return {
    state: winner.state,
    visibleBlocker: Boolean(winner.visibleBlocker) && winner.state === 'blocked',
    visibleWorking: Boolean(winner.visibleWorking) && winner.state === 'working',
    visibleIdle: Boolean(winner.visibleIdle) && winner.state === 'idle',
    skipStateUpdate: Boolean(winner.skipStateUpdate),
    matchedRuleId: winner.id,
  };
}
