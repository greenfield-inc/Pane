import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNPANE_CONTRACT } from '../../../../shared/types/generatedRunpaneContract';
import { PANE_CAPABILITY_CONTEXT } from '../../../../shared/types/sessionProfile';
import { prepareSessionWorkspace } from '../sessionWorkspace';
import { SkillCacheManager } from '../skillCacheManager';
import { AGENT_REPLY_RULE, REPLY_RULE_PHRASES } from './agentMessageText';

const repo = path.join(__dirname, '..', '..', '..', '..');
const read = (file: string) => fs.readFile(file, 'utf8');
const flat = (text: string) => text.replace(/\s+/g, ' ');

/** A markdown section's text: from its heading line to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`${heading}\n`);
  if (start < 0) return '';
  const level = heading.indexOf(' ');
  const rest = text.slice(start + heading.length + 1);
  const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'));
  return next < 0 ? rest : rest.slice(0, next);
}

function expectRule(text: string, where: string): void {
  for (const phrase of REPLY_RULE_PHRASES) expect(flat(text), `${where} must say ${phrase}`).toContain(phrase);
}

describe('the runpane reply rule: one wording everywhere an agent learns to answer a message (T-104)', () => {
  const previousPaneDir = process.env.PANE_DIR;
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-reply-rule-'));
    process.env.PANE_DIR = root;
  });

  afterEach(async () => {
    if (previousPaneDir === undefined) delete process.env.PANE_DIR;
    else process.env.PANE_DIR = previousPaneDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('the source rule carries both phrases', () => {
    expectRule(AGENT_REPLY_RULE, 'AGENT_REPLY_RULE');
  });

  it("is in each Session's AGENTS.md: its Pane capabilities section and its orchestrator mode", async () => {
    expect(PANE_CAPABILITY_CONTEXT).toContain(AGENT_REPLY_RULE);
    const agents = await read(path.join(prepareSessionWorkspace('reply-rule'), 'AGENTS.md'));
    for (const heading of ['## Pane capabilities and authority', '## Orchestrator mode']) {
      expect(section(agents, heading), `AGENTS.md ${heading}`).toContain(AGENT_REPLY_RULE);
    }
  });

  it('is in every copy of the pane-orchestrator skill, under Messages from other agents', async () => {
    const manager = new SkillCacheManager();
    await manager.ensurePaneChatGuide();
    for (const file of [manager.paneChatOrchestratorSkillPath, manager.codexPaneOrchestratorSkillPath, manager.claudePaneOrchestratorSkillPath, manager.cursorPaneOrchestratorRulePath]) {
      const text = await read(file);
      expect(text, file).toContain('# Pane Orchestrator (Sessions)');
      expect(section(text, '## Messages from other agents'), file).toContain(AGENT_REPLY_RULE);
    }
  });

  it('is in the bundled pane-orchestration guide and both copies of the messaging skill', async () => {
    for (const file of [
      'main/src/services/paneChatBundle/skills/pane-orchestration/SKILL.md',
      'main/src/services/userSkills/pane-manage-and-message-agents/SKILL.md',
      'claude-plugin/skills/pane-manage-and-message-agents/SKILL.md',
    ]) expectRule(await read(path.join(repo, file)), file);
  });

  it('is in runpane agent-context: its workspace rules and the reply command', () => {
    const { workspaceRules, commands } = RUNPANE_CONTRACT.agentContext;
    expectRule(workspaceRules.find(rule => rule.startsWith('Messages:')) ?? '', 'agentContext.workspaceRules Messages:');
    expectRule(commands.reply.notes.join(' '), 'agentContext.commands.reply.notes');
  });

  it('catches a surface whose wording drifted', () => {
    expect(() => expectRule('Answer with runpane respond M-12 "…", never only in your own chat.', 'sample')).toThrow();
  });
});
