import { describe, expect, it } from 'vitest';
import { claudeChatProfile, codexChatProfile } from './launchProfile';

describe('switchable native launch capability', () => {
  it('preserves Codex native config and maps explicit CLI policy without inventing a preset', () => {
    expect(codexChatProfile('"C:\\Program Files\\Codex\\codex.exe" --model gpt-6 --sandbox workspace-write --ask-for-approval on-request -c model_reasoning_effort="low" --profile work', 'win32')).toEqual({
      executable: 'C:\\Program Files\\Codex\\codex.exe',
      configArgs: ['--config', 'model="gpt-6"', '--config', 'sandbox_mode="workspace-write"', '--config', 'approval_policy="on-request"', '--config', 'model_reasoning_effort=low', '--config', 'profile="work"'],
    });
    expect(codexChatProfile('codex --yolo')).toMatchObject({ configArgs: ['--config', 'approval_policy="never"', '--config', 'sandbox_mode="danger-full-access"'] });
  });
  it('recognizes Windows Claude executables and npm command shims without losing launch settings', () => {
    expect(claudeChatProfile('"C:\\Program Files\\Claude\\claude.exe" --model sonnet --effort high', 'win32')).toEqual({
      executable: 'C:\\Program Files\\Claude\\claude.exe', model: 'sonnet', effort: 'high', strictMcpConfig: false,
    });
    expect(claudeChatProfile('claude.cmd --permission-mode acceptEdits', 'win32')).toMatchObject({ executable: 'claude.cmd', permissionMode: 'acceptEdits' });
  });
  it('preserves explicit Claude model, effort, permission and MCP choices while declining opaque launchers', () => {
    expect(claudeChatProfile('claude --model sonnet --effort high --permission-mode acceptEdits --strict-mcp-config')).toEqual({ executable: 'claude', model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits', strictMcpConfig: true });
    expect(claudeChatProfile('claude --dangerously-skip-permissions')).toMatchObject({ permissionMode: 'bypassPermissions' });
    expect(claudeChatProfile('env KEY=value claude')).toBeUndefined();
    expect(claudeChatProfile('claude --mcp-config custom.json')).toBeUndefined();
    expect(claudeChatProfile('claude --resume latest')).toBeUndefined();
    expect(claudeChatProfile('claude; echo surprise')).toBeUndefined();
    expect(claudeChatProfile('codex --no-daemon')).toBeUndefined();
  });
});
