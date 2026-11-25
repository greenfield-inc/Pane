/* global process */
// A stand-in for `agent-farm run <profile> --print-acp --acp-adapter <entry> [--arg k=v]`:
// prints the ACP launch contract (Agent Farm CONFIGURATION.md, "ACP sessions"),
// pointing argv at the scripted agent. FAKE_AGENT_FARM_HARNESS picks the harness.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (args[0] !== 'run' || !args.includes('--print-acp')) { process.stderr.write('fake agent-farm: expected run --print-acp\n'); process.exit(2); }
const profile = args[1];
const launchArgs = Object.fromEntries(args.flatMap((arg, index) => arg === '--arg' ? [args[index + 1].split('=')] : []));
if (profile === 'old/agent-farm') { process.stderr.write("error: Unknown option '--print-acp'\n"); process.exit(1); }
if (profile === 'missing/profile') { process.stderr.write('Unknown profile: missing/profile\n'); process.exit(1); }
const harness = process.env.FAKE_AGENT_FARM_HARNESS ?? 'claude';
const launchContext = ['LAUNCH CONTEXT', 'headless: false', ...Object.entries(launchArgs).map(([key, value]) => `${key}: ${value}`)].join('\n');
// As Agent Farm 0.2.34 prints them: Claude's instructions, skills and MCP servers in _meta; Codex's in CODEX_CONFIG.
const session = { cwd: process.cwd(), mcpServers: [] };
if (harness === 'claude') {
  session._meta = {
    systemPrompt: { append: `Profile ${profile}\n\n${launchContext}` },
    claudeCode: { options: { model: 'claude-opus-5-5', plugins: [{ type: 'local', path: '/bundle/main' }], mcpServers: { profile_server: { type: 'stdio', command: 'x', args: [], env: {} } }, strictMcpConfig: true } },
  };
}
process.stdout.write(JSON.stringify({
  harness,
  adapter: { package: `@agentclientprotocol/${harness === 'claude' ? 'claude-agent-acp' : 'codex-acp'}`, version: harness === 'claude' ? '0.100.0' : '2.5.0' },
  argv: [process.execPath, path.join(path.dirname(fileURLToPath(import.meta.url)), 'scriptedAgent.mjs')],
  cwd: process.cwd(),
  env: {
    AGENT_FARM_PROFILE: profile,
    ...(harness === 'claude' ? { ANTHROPIC_MODEL: 'claude-opus-5-5' } : {
      INITIAL_AGENT_MODE: 'agent-full-access',
      CODEX_CONFIG: JSON.stringify({ model: 'gpt-6-astra', developer_instructions: `Profile ${profile}\n\n${launchContext}`, mcp_servers: {} }),
    }),
  },
  session,
  model: 'claude-opus-5-5', effort: 'medium', mode: harness === 'claude' ? 'bypassPermissions' : 'agent-full-access',
  profile,
}));
