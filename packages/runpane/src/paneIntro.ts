import fs from 'fs';
import path from 'path';
import { boundary, decodeBoundary } from './boundaryDecoder';
import { RUNPANE_CONTRACT } from './generated/contract';

interface IntroPart {
  title: string;
  sentences: readonly string[];
  approvals: { on: string; off: string };
}

/** What Pane is and how to work in it, people first, rendered for this person's Approvals setting. */
export interface PaneIntro {
  humans: string;
  agents: string;
  /** Whether Approvals is on, which picks each part's sentence about asking the person. */
  approvals: boolean;
}

const approvalsConfigSchema = boundary.object({
  notify: boundary.optional(boundary.object({ enabled: boundary.optional(boundary.boolean) })),
});

/** Approvals (`notify.enabled` in `<pane-dir>/config.json`) is on unless the person turned it off. */
function approvalsEnabled(paneDir: string): boolean {
  try {
    const config = decodeBoundary(JSON.parse(fs.readFileSync(path.join(paneDir, 'config.json'), 'utf8')), approvalsConfigSchema);
    return config.notify?.enabled !== false;
  } catch {
    return true;
  }
}

function renderPart(part: IntroPart, approvals: boolean): string {
  return part.sentences
    .map((sentence) => (sentence === '{approvals}' ? (approvals ? part.approvals.on : part.approvals.off) : sentence))
    .join(' ');
}

export function paneIntro(paneDir: string): PaneIntro {
  const { humans, agents } = RUNPANE_CONTRACT.agentContext.intro;
  const approvals = approvalsEnabled(paneDir);
  return { humans: renderPart(humans, approvals), agents: renderPart(agents, approvals), approvals };
}

/** The intro as text: each part under its title, then the working rules when given. */
export function renderPaneIntro(intro: PaneIntro, rules: readonly string[] = []): string {
  const { humans, agents } = RUNPANE_CONTRACT.agentContext.intro;
  const lines = [`${humans.title}:`, intro.humans, '', `${agents.title}:`, intro.agents];
  if (rules.length > 0) lines.push('', 'Working in Pane:', ...rules.map((rule) => `- ${rule}`));
  return lines.join('\n');
}

/**
 * The "For agents" part without its sentence about reaching the person, for instruction text that
 * states its own asking rules (the CLAUDE.md/AGENTS.md block, the MCP server, the pane skill).
 */
export function agentsIntroForInstructions(): string {
  return RUNPANE_CONTRACT.agentContext.intro.agents.sentences.filter((sentence) => sentence !== '{approvals}').join(' ');
}

/** The working rule for scratch files, which overrides an agent's own default of /tmp or a private scratchpad. */
export function scratchRule(): string {
  const rule = RUNPANE_CONTRACT.agentContext.workspaceRules.find((text) => text.startsWith('Scratch:'));
  if (!rule) throw new Error('agentContext.workspaceRules has no "Scratch:" rule');
  return rule;
}
