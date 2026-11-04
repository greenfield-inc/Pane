import { describe, expect, it } from 'vitest';
import type { ClaudeHookEvent } from './claudeHookEvent';
import { claudePromptQuestion } from './claudePromptQuestion';

const cwd = '/work/acme-web';

/** The shape Claude Code 2.1.314 sent for a Bash prompt, with the suggestions its dialog offers. */
const bashPrompt: ClaudeHookEvent = {
  hook_event_name: 'PermissionRequest',
  session_id: 's-1',
  cwd,
  tool_name: 'Bash',
  tool_input: { command: 'pnpm vitest run src/http', description: 'Run the http tests' },
  permission_suggestions: [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm vitest:*' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addDirectories', directories: [cwd], destination: 'session' },
  ],
};

describe('claudePromptQuestion', () => {
  it("offers the terminal dialog's choices for a command, and the phone's Yes and No", () => {
    const { question } = claudePromptQuestion(bashPrompt, 'acme-web');

    expect(question.title).toBe('Run pnpm vitest run src/http?');
    expect(question.context).toBe('Run the http tests');
    expect(question.choices?.map(choice => choice.label)).toEqual([
      'Yes',
      "Yes, and don't ask again for pnpm vitest commands in acme-web",
      'Yes, and allow access to this folder for this session',
      'No',
    ]);
    expect(question.agentPrompt).toEqual({ yes: 'Yes', no: 'No' });
  });

  it('allows, remembers the chosen rule, or says no with or without a reason', () => {
    const { decide } = claudePromptQuestion(bashPrompt, 'acme-web');

    expect(decide('Yes')).toEqual({ behavior: 'allow' });
    expect(decide("Yes, and don't ask again for pnpm vitest commands in acme-web")).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm vitest:*' }], behavior: 'allow', destination: 'localSettings' }],
    });
    expect(decide('No', 'Run only the unit tests')).toEqual({ behavior: 'deny', message: 'The user said no. The user answered this prompt in Pane and wrote: Run only the unit tests' });
    // Like No in the terminal: Claude stops and waits.
    expect(decide('No')).toMatchObject({ behavior: 'deny', interrupt: true });
  });

  it('approves a plan into the chosen mode with the plan echoed, or keeps planning with the note', () => {
    const input = { plan: '1. Add the endpoint\n2. Test it', planFilePath: '/home/me/.claude/plans/p.md' };
    const { question, decide } = claudePromptQuestion({ hook_event_name: 'PermissionRequest', session_id: 's-1', cwd, tool_name: 'ExitPlanMode', tool_input: input }, 'acme-web');

    expect(question.title).toBe("Approve Claude's plan?");
    expect(question.context).toBe('1. Add the endpoint\n2. Test it');
    expect(decide('Yes, and auto-accept edits')).toEqual({
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    expect(decide('Yes, and manually approve edits')).toMatchObject({ updatedPermissions: [{ mode: 'default' }] });
    expect(decide('No, keep planning', 'Split step 2')).toEqual({ behavior: 'deny', message: 'The user wants to keep planning. The user answered this prompt in Pane and wrote: Split step 2' });
  });

  it('shows the whole of a long command, so Yes never approves a part the person could not read', () => {
    const command = `${'echo step; '.repeat(410)}rm -rf ~/.ssh`;
    const { question } = claudePromptQuestion({ ...bashPrompt, tool_input: { command, description: 'Run the generated script' } }, 'acme-web');

    expect(command.length).toBeGreaterThan(4_000);
    expect(question.context).toBe(`Run the generated script\n\n${command}`);
    expect(question.agentPrompt?.inTerminal).toBeUndefined();
  });

  it('leaves a command too long to show in full to the terminal, with no choices in Pane', () => {
    const command = `${'x'.repeat(40_000)} && rm -rf ~/.ssh`;
    const { question } = claudePromptQuestion({ ...bashPrompt, tool_input: { command } }, 'acme-web');

    expect(question.agentPrompt).toEqual({ yes: 'Yes', no: 'No', inTerminal: true });
    expect(question.context).toMatch(/^This command is 40,\d{3} characters, too long to show here in full\. Answer in the terminal/);
  });

  it('applies the same rule to plans and other tools: whole details, or the terminal', () => {
    const plan = `${'1. A step\n'.repeat(600)}2. Delete the staging database`;
    const exitPlan = (text: string) => claudePromptQuestion({ hook_event_name: 'PermissionRequest', session_id: 's-1', cwd, tool_name: 'ExitPlanMode', tool_input: { plan: text } }, 'acme-web').question;
    expect(exitPlan(plan).context).toBe(plan);
    expect(exitPlan(plan.repeat(10)).agentPrompt?.inTerminal).toBe(true);

    const body = 'b'.repeat(5_000);
    const mcp = claudePromptQuestion({ hook_event_name: 'PermissionRequest', session_id: 's-1', cwd, tool_name: 'mcp__github__create_issue', tool_input: { body } }, 'acme-web').question;
    expect(mcp.context).toBe(JSON.stringify({ body }, null, 2));
  });

  it('names MCP tools by tool and server', () => {
    const { question } = claudePromptQuestion({ hook_event_name: 'PermissionRequest', session_id: 's-1', cwd, tool_name: 'mcp__github__create_issue', tool_input: { title: 'Bug' } }, 'acme-web');
    expect(question.title).toBe('Use create_issue from github?');
  });
});
