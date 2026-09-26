/**
 * Per-agent status-detection manifests for Pane's at-a-glance agent status.
 *
 * Each manifest is a priority-ordered rule set consumed by {@link detectAgentState}
 * in manifestEngine. Rules classify a pane's live terminal snapshot as `blocked`
 * (waiting on the human), `working`, or `idle`; `unknown` + skipStateUpdate marks
 * agent-owned viewers (transcript/model picker) so the previously known state is
 * held. Working is also corroborated by PTY byte-activity in the monitor.
 *
 * Rules encode the visible chrome each CLI agent renders (permission prompts,
 * spinners, prompt boxes) so classification is derived from what the user would
 * see on screen, not from process-level guesswork.
 */

import type { AgentManifest } from './manifestEngine';

/** Observed working-title glyphs, including older braille animation. */
const SPINNER_TITLE = /^[◐◑◒◓\u{2800}-\u{28FF}] /u;
const CODEX_SPINNER = /(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)/u;
/** Codex's header while it boots; its composer shows early and may give way to the trust prompt. */
export const CODEX_LOADING_HEADER = /\bmodel:\s+loading\b/;

export const CLAUDE_MANIFEST: AgentManifest = {
  id: 'claude',
  rules: [
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 990,
      region: 'osc_title',
      visibleWorking: true,
      regex: [SPINNER_TITLE],
    },
    {
      id: 'spinner_status_line',
      state: 'working',
      priority: 974,
      region: 'bottom_non_empty_lines(8)',
      visibleWorking: true,
      lineRegex: [/^\s*[·✶✻✽✢✳]\s+[\p{L} -]+…(?:\s+\([^)]*\))?\s*$/u],
    },
    {
      id: 'btw_overlay_working',
      state: 'working',
      priority: 975,
      region: 'bottom_non_empty_lines(5)',
      visibleWorking: true,
      lineRegex: [/^\s*\/btw(?:\s|$)/, /esc to close\s*$/i],
    },
    {
      id: 'high_effort_thinking_working',
      state: 'working',
      priority: 976,
      region: 'bottom_non_empty_lines(5)',
      visibleWorking: true,
      lineRegex: [/^\s*·\s+.+…\s+\([^)]*\bthinking\b[^)]*\)\s*$/iu, /esc to interrupt/i],
    },
    {
      id: 'api_retry_working',
      state: 'working',
      priority: 977,
      region: 'bottom_non_empty_lines(6)',
      visibleWorking: true,
      lineRegex: [
        /(?:Retrying in \d+s?\s*·\s*attempt \d+\/\d+)|(?:(?:API error|Connection (?:lost|dropped)[^·\n]*)\s*·\s*Retrying)/iu,
      ],
    },
    {
      id: 'transcript_viewer',
      state: 'unknown',
      priority: 1000,
      region: 'bottom_non_empty_lines(3)',
      skipStateUpdate: true,
      contains: ['showing detailed transcript'],
      any: [
        { contains: ['ctrl+o', 'to toggle'] },
        { contains: ['ctrl+e', 'show all'] },
        { contains: ['ctrl+e', 'collapse'] },
        { contains: ['↑↓ scroll'] },
        { contains: ['? for shortcuts'] },
      ],
    },
    {
      id: 'live_blocked_form',
      state: 'blocked',
      priority: 1100,
      region: 'after_last_horizontal_rule',
      visibleBlocker: true,
      contains: ['enter to select', 'esc to cancel'],
      any: [
        { contains: ['tab/arrow keys to navigate'] },
        { contains: ['arrow keys to navigate'] },
        { contains: ['arrows to navigate'] },
        { contains: ['↑/↓ to navigate'] },
        { contains: ['↑↓ to navigate'] },
      ],
    },
    {
      // Startup menus: folder trust and bypass-permissions warnings ("❯ No, exit"
      // above "Enter to confirm · Esc to cancel"), and first-run theme and login
      // pickers ("❯ 2. Dark mode").
      id: 'live_selection_menu',
      state: 'blocked',
      priority: 1100,
      region: 'after_last_horizontal_rule',
      visibleBlocker: true,
      lineRegex: [/^\s*❯\s*\S/],
      any: [{ contains: ['enter to confirm'] }, { lineRegex: [/^\s*❯\s*\d+\.\s/] }],
    },
    {
      id: 'dynamic_workflow_prompt',
      state: 'blocked',
      priority: 1100,
      region: 'after_last_horizontal_rule',
      visibleBlocker: true,
      contains: ['run a dynamic workflow?', 'esc to cancel'],
    },
    {
      id: 'live_prompt_box',
      state: 'idle',
      priority: 950,
      region: 'prompt_box_body',
      // The composer remains visible mid-turn; it is not completion evidence.
      lineRegex: [/^\s*❯/],
      not: [
        { contains: ['enter to select'] },
        { contains: ['esc to cancel'] },
        { contains: ['tab/arrow keys'] },
        { contains: ['arrow keys to navigate'] },
        { contains: ['↑/↓ to navigate'] },
      ],
    },
    {
      id: 'model_picker_menu',
      state: 'unknown',
      priority: 900,
      region: 'whole_recent',
      skipStateUpdate: true,
      contains: ['select model', 'enter to set as default', 'esc to cancel'],
      not: [{ contains: ['do you want to proceed?'] }, { contains: ['enter to select'] }],
    },
    {
      id: 'bash_permission_prompt',
      state: 'blocked',
      priority: 1100,
      region: 'after_last_horizontal_rule',
      visibleBlocker: true,
      contains: ['do you want to proceed?'],
      any: [
        { contains: ['bash command'] },
        { contains: ['bash('] },
        { contains: ['contains expansion'] },
        { contains: ['tab to amend'] },
        { contains: ['ctrl+e to explain'] },
      ],
      all: [
        {
          any: [
            { lineRegex: [/^\s*❯?\s*yes\b/i] },
            { lineRegex: [/^\s*1\.\s*yes\b/i] },
            { lineRegex: [/^\s*2\.\s*no\b/i] },
          ],
        },
      ],
    },
    {
      id: 'generic_permission_prompt',
      state: 'blocked',
      priority: 1100,
      region: 'after_last_horizontal_rule',
      visibleBlocker: true,
      contains: ['do you want to proceed?', 'esc to cancel'],
      all: [
        {
          any: [
            { lineRegex: [/^\s*❯?\s*1\.\s*yes\b/i] },
            { lineRegex: [/^\s*2\.\s*yes\b/i] },
            { lineRegex: [/^\s*2\.\s*no\b/i] },
            { lineRegex: [/^\s*3\.\s*no\b/i] },
          ],
        },
      ],
    },
    {
      id: 'legacy_no_prompt_blocker',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      any: [
        { contains: ['do you want to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
        { contains: ['would you like to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
        { contains: ['waiting for permission'] },
        { contains: ['do you want to allow this connection?'] },
        { contains: ['tab to amend'] },
        { contains: ['ctrl+e to explain'] },
        { contains: ['do you want to proceed?', 'esc to cancel'] },
        { contains: ['review your answers'] },
        { contains: ['skip interview and plan immediately'] },
        { contains: ['paste code here if prompted'] },
      ],
      not: [{ regex: [/^\s*❯\s*$/m] }],
    },
    {
      id: 'osc_title_idle',
      state: 'idle',
      priority: 960,
      region: 'osc_title',
      visibleIdle: true,
      regex: [/^\u{2733} /u],
    },
    {
      id: 'osc_progress_idle',
      state: 'idle',
      priority: 250,
      region: 'osc_progress',
      regex: [/^4;0/],
    },
  ],
};

export const CODEX_MANIFEST: AgentManifest = {
  id: 'codex',
  rules: [
    {
      id: 'osc_title_blocked',
      state: 'blocked',
      priority: 1100,
      region: 'osc_title',
      visibleBlocker: true,
      contains: ['Action Required'],
    },
    {
      id: 'osc_title_working',
      state: 'working',
      priority: 1050,
      region: 'osc_title',
      visibleWorking: true,
      regex: [CODEX_SPINNER],
    },
    {
      id: 'transcript_viewer',
      state: 'unknown',
      priority: 1000,
      region: 'after_last_prompt_marker',
      skipStateUpdate: true,
      contains: ['↑/↓ to scroll', 'pgup/pgdn to', 'home/end to jump'],
      all: [
        { any: [{ contains: ['q to quit'] }, { contains: ['q close'] }] },
        { any: [{ contains: ['esc to edit prev'] }, { contains: ['esc/← to edit prev'] }] },
      ],
    },
    {
      id: 'live_strong_blocker',
      state: 'blocked',
      priority: 900,
      region: 'after_last_prompt_marker',
      visibleBlocker: true,
      any: [
        { contains: ['press enter to confirm or esc to cancel'] },
        { contains: ['enter to submit answer'] },
        { contains: ['enter to submit all'] },
        { contains: ['allow command?'] },
        // Folder-trust prompt footer.
        { contains: ['enter continue', 'esc quit'] },
      ],
    },
    {
      id: 'weak_blocker',
      state: 'blocked',
      priority: 600,
      region: 'after_last_prompt_marker',
      visibleBlocker: true,
      regex: [/(?:^|\n)[^\n]*\?\s*(?:\[y\/n[^\]]*\]|yes \(y\))\s*:?\s*$/i],
    },
    {
      id: 'startup_loading',
      state: 'working',
      priority: 550,
      region: 'whole_recent',
      visibleWorking: true,
      regex: [CODEX_LOADING_HEADER],
    },
    {
      id: 'screen_working_fallback',
      state: 'working',
      priority: 500,
      region: 'bottom_non_empty_lines(6)',
      visibleWorking: true,
      regex: [/^\s*[•◦]\s+Working \([^)]*esc\s+to\s+interrupt\)(?: · [^\n]*)?\s*$/m],
      not: [{ contains: ['■ Conversation interrupted'] }],
    },
    {
      id: 'osc_title_idle',
      state: 'idle',
      priority: 100,
      region: 'osc_title',
      visibleIdle: true,
      regex: [/\S/],
      not: [{ regex: [CODEX_SPINNER] }, { contains: ['Action Required'] }],
    },
  ],
};

/**
 * Universal fallback for any terminal panel without a bespoke manifest — other
 * CLI agents (opencode, aider, ...) and plain shells alike. Blocked requires a
 * LIVE prompt: the last non-empty line must itself end in a prompt shape, so a
 * finished command whose scrollback still shows "[y/n]" text (answered prompts,
 * an apt run above a fresh shell prompt) is not classified blocked. Working and
 * idle come from PTY activity and the idle fallback.
 */
export const GENERIC_MANIFEST: AgentManifest = {
  id: 'generic',
  rules: [
    {
      id: 'generic_live_prompt',
      state: 'blocked',
      priority: 600,
      region: 'bottom_non_empty_lines(1)',
      visibleBlocker: true,
      any: [
        { lineRegex: [/\[y\/n[^\]]*\]\s*:?\s*$/i] },
        { lineRegex: [/\(y\/n[^)]*\)\s*:?\s*$/i] },
        { lineRegex: [/press enter to confirm\.?\s*$/i] },
        { lineRegex: [/(?:do you want|would you like)\b[^?]*\?\s*$/i] },
        { lineRegex: [/allow command\?\s*$/i] },
        { lineRegex: [/waiting for permission\.{0,3}\s*$/i] },
      ],
    },
  ],
};

/*
 * Distilled from real cursor-agent 2026.08.11-e8db854 screens. Cursor renders
 * inline (no alternate screen) and is fully quiescent when idle; its OSC 0
 * title becomes the chat name after the first exchange, so titles carry no
 * status signal and are deliberately unused here.
 */
export const CURSOR_MANIFEST: AgentManifest = {
  id: 'cursor',
  rules: [
    {
      id: 'workspace_trust_prompt',
      state: 'blocked',
      priority: 1000,
      region: 'whole_recent',
      visibleBlocker: true,
      contains: ['workspace trust required', 'do you trust the contents of this directory?'],
    },
    {
      id: 'live_approval_prompt',
      state: 'blocked',
      priority: 900,
      region: 'after_last_horizontal_rule',
      visibleBlocker: true,
      contains: ['run this command?'],
      any: [{ contains: ['run (once) (y)'] }, { contains: ['esc or n'] }],
    },
    {
      id: 'spinner_status_line',
      state: 'working',
      priority: 500,
      region: 'bottom_non_empty_lines(8)',
      visibleWorking: true,
      lineRegex: [/^\s*[⠀-⣿][⠀-⣿\s]*\s*(Working|Running|Loading conversation)\b/],
    },
    {
      id: 'interruptible_composer',
      state: 'working',
      priority: 450,
      region: 'bottom_non_empty_lines(4)',
      visibleWorking: true,
      contains: ['ctrl+c to stop'],
    },
    {
      id: 'idle_composer',
      state: 'idle',
      priority: 300,
      region: 'bottom_non_empty_lines(4)',
      visibleIdle: true,
      any: [
        { contains: ['plan, search, build anything'] },
        { contains: ['add a follow-up'] },
      ],
      not: [{ contains: ['ctrl+c to stop'] }],
    },
  ],
};

interface AgentManifestLookup {
  [agent: string]: AgentManifest;
}

const MANIFESTS_BY_AGENT: AgentManifestLookup = {
  claude: CLAUDE_MANIFEST,
  codex: CODEX_MANIFEST,
  cursor: CURSOR_MANIFEST,
};

/**
 * Resolve the manifest for a panel's agent type. Known agents get their bespoke
 * manifest; everything else — unrecognized CLI agents and plain shells — gets
 * the generic fallback, so every terminal panel is covered by one status system.
 */
export function getManifestForAgent(agentType: string | undefined | null): AgentManifest {
  if (!agentType) return GENERIC_MANIFEST;
  return MANIFESTS_BY_AGENT[agentType] ?? GENERIC_MANIFEST;
}
