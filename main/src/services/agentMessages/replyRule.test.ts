import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNPANE_CONTRACT } from '../../../../shared/types/generatedRunpaneContract';
import { prepareSessionWorkspace } from '../sessionWorkspace';
import { SkillCacheManager } from '../skillCacheManager';
import { AGENT_REPLY_RULE, REPLY_RULE_PHRASES } from './agentMessageText';

const repo = path.join(__dirname, '..', '..', '..', '..');
const read = (file: string) => fs.readFile(file, 'utf8');
const flat = (text: string) => text.replace(/\s+/g, ' ');

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

  it("is in each Session's AGENTS.md and every copy of the pane-orchestrator skill", async () => {
    const agents = await read(path.join(prepareSessionWorkspace('reply-rule'), 'AGENTS.md'));
    expect(agents).toContain(AGENT_REPLY_RULE);
    const manager = new SkillCacheManager();
    await manager.ensurePaneChatGuide();
    for (const file of [manager.paneChatOrchestratorSkillPath, manager.codexPaneOrchestratorSkillPath, manager.claudePaneOrchestratorSkillPath, manager.cursorPaneOrchestratorRulePath]) {
      expect(await read(file), file).toContain(AGENT_REPLY_RULE);
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
