import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import { APPROVALS_RULES, APPROVALS_RULES_POINTER } from './approvalsRules';
import { buildPaneHomeSkill } from './paneHomeSkill';
import { prepareSessionWorkspace } from './sessionWorkspace';
import { SkillCacheManager } from './skillCacheManager';

const bundle = path.join(__dirname, 'paneChatBundle', 'skills');
const read = (file: string) => fs.readFile(file, 'utf8');

/** Wording that would send a worker's or a relayed question through Claude's own card. */
const ASK_USER_QUESTION_INSTRUCTION = /\b(use|call|through|with|via|put [^.]* through)\s+(the\s+)?`?AskUserQuestion`?|harness question tool/i;

function expectNoAskUserQuestionInstruction(text: string, where: string): void {
  for (const sentence of text.replace(/\s+/g, ' ').split(/(?<=[.;:])\s/)) {
    if (!/AskUserQuestion|harness question tool/i.test(sentence)) continue;
    // Naming it to forbid it ("never", "not", "don't") is fine; telling an agent to use it is not.
    if (/\b(never|not|don't|no)\b/i.test(sentence)) continue;
    expect(sentence, where).not.toMatch(ASK_USER_QUESTION_INSTRUCTION);
  }
}

describe('Pane approvals rules: one text everywhere an agent learns to ask (D-342.1, D-347)', () => {
  const previousPaneDir = process.env.PANE_DIR;
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-approvals-rules-'));
    process.env.PANE_DIR = root;
  });

  afterEach(async () => {
    if (previousPaneDir === undefined) delete process.env.PANE_DIR;
    else process.env.PANE_DIR = previousPaneDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('carries the whole section in the generated pane-orchestrator skill, all four copies', async () => {
    const manager = new SkillCacheManager();
    await manager.ensurePaneChatGuide();
    for (const file of [manager.paneChatOrchestratorSkillPath, manager.codexPaneOrchestratorSkillPath, manager.claudePaneOrchestratorSkillPath, manager.cursorPaneOrchestratorRulePath]) {
      const text = await read(file);
      expect(text, file).toContain(APPROVALS_RULES);
      expectNoAskUserQuestionInstruction(text.replace(APPROVALS_RULES, ''), file);
    }
  });

  it('keeps the bundled pane-orchestration guide\'s marked block the same as the source', async () => {
    const text = await read(path.join(bundle, 'pane-orchestration', 'SKILL.md'));
    const block = /<!-- approvals-rules:start[^>]*-->\n([\s\S]*?)\n<!-- approvals-rules:end -->/.exec(text)?.[1];
    expect(block, 'Copy APPROVALS_RULES from approvalsRules.ts between the approvals-rules markers').toBe(APPROVALS_RULES);
    expectNoAskUserQuestionInstruction(text.replace(APPROVALS_RULES, ''), 'pane-orchestration/SKILL.md');
  });

  it('carries the section in each Session\'s AGENTS.md', async () => {
    const cwd = prepareSessionWorkspace('approvals-rules');
    const agents = await read(path.join(cwd, 'AGENTS.md'));
    expect(agents).toContain(APPROVALS_RULES);
    expectNoAskUserQuestionInstruction(agents.replace(APPROVALS_RULES, ''), 'Session AGENTS.md');
  });

  it('carries the section in the pane home skill, under the name the pointer gives', () => {
    const skill = buildPaneHomeSkill();
    expect(skill).toContain(APPROVALS_RULES);
    expect(APPROVALS_RULES.startsWith('## Asking the person in Pane\n')).toBe(true);
    expect(APPROVALS_RULES_POINTER).toContain('"Asking the person in Pane"');
    expectNoAskUserQuestionInstruction(skill.replace(APPROVALS_RULES, ''), 'pane home skill');
  });

  it('points the bundled orchestrate-sessions skill at the section and never relays through Claude\'s card', async () => {
    const skill = await read(path.join(bundle, 'orchestrate-sessions', 'SKILL.md'));
    const relay = await read(path.join(bundle, 'orchestrate-sessions', 'references', 'relay.md'));
    expect(skill).toContain('[references/relay.md](references/relay.md)');
    expect(skill).toContain('"Asking the person in Pane"');
    expect(relay).toContain('"Asking the person in Pane"');
    expect(relay).toContain('## A check, not a pipe');
    expect(relay).toContain('clarify: Q-n → <the person\'s question>');
    expectNoAskUserQuestionInstruction(skill, 'orchestrate-sessions/SKILL.md');
    expectNoAskUserQuestionInstruction(relay, 'orchestrate-sessions/references/relay.md');
  });

  it('gives the same which-card rule in the notify guidance and the managed AGENTS.md block', () => {
    const { notifyGuidance, managedBlock } = RUNPANE_CONTRACT.agentContext;
    const guidance = notifyGuidance.rules.join('\n');
    const block = managedBlock.join('\n');
    for (const [where, text] of [['notifyGuidance', guidance], ['managedBlock', block]] as const) {
      expect(text, where).toContain("Claude's own card (AskUserQuestion)");
      expect(text, where).toContain('approval card');
      expectNoAskUserQuestionInstruction(text, where);
    }
  });

  it('catches a text that tells an agent to use AskUserQuestion', () => {
    expect(() => expectNoAskUserQuestionInstruction('Relay the question with AskUserQuestion once the files are open.', 'sample')).toThrow();
    expect(() => expectNoAskUserQuestionInstruction('On Claude, put the questions through the harness question tool.', 'sample')).toThrow();
    expect(() => expectNoAskUserQuestionInstruction("Don't block your turn on AskUserQuestion.", 'sample')).not.toThrow();
  });
});
