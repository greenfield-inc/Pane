import type { RunpaneAgentId, RunpaneAgentSignIn } from '../../../../shared/types/runpaneOrchestration';
import { boundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';

const SIGN_IN_TIMEOUT_MS = 3_000;

interface SignInRunner {
  execAsync(command: string, cwd: string, options: { timeout: number; silent: true }): Promise<{ stdout: string; stderr: string }>;
}

interface StatusOutput {
  exitCode: number;
  text: string;
}

/** Each agent's own status command, run with the arguments after its executable. */
const STATUS_ARGS = {
  claude: 'auth status',
  codex: 'login status',
  cursor: 'status --format json',
  opencode: 'auth list',
} satisfies Record<RunpaneAgentId, string>;

/** Node's exec rejects a non-zero exit with its code and output; a timeout kill has no numeric code. */
const exitErrorSchema = boundary.object({
  code: boundary.number,
  stdout: boundary.optional(boundary.string),
  stderr: boundary.optional(boundary.string),
});
const claudeStatusSchema = boundary.object({ loggedIn: boundary.boolean });
const cursorStatusSchema = boundary.object({ isAuthenticated: boundary.boolean });

/**
 * Asks the agent's CLI whether it is signed in, the way the agent will run
 * (through the project's command runner, so a WSL repo checks inside its
 * distro). A timeout or output the parser does not recognise is `unknown`.
 */
export async function checkAgentSignIn(
  runner: SignInRunner,
  cwd: string,
  agent: RunpaneAgentId,
  quotedExecutable: string,
): Promise<RunpaneAgentSignIn> {
  const output = await runStatus(runner, cwd, `${quotedExecutable} ${STATUS_ARGS[agent]}`);
  return output ? parseSignIn(agent, output) : 'unknown';
}

async function runStatus(runner: SignInRunner, cwd: string, command: string): Promise<StatusOutput | undefined> {
  try {
    const result = await runner.execAsync(command, cwd, { timeout: SIGN_IN_TIMEOUT_MS, silent: true });
    return { exitCode: 0, text: `${result.stdout}\n${result.stderr}` };
  } catch (error) {
    const exit = decodeOptionalBoundary(error, exitErrorSchema);
    return exit && { exitCode: exit.code, text: `${exit.stdout ?? ''}\n${exit.stderr ?? ''}` };
  }
}

function parseSignIn(agent: RunpaneAgentId, output: StatusOutput): RunpaneAgentSignIn {
  const { text } = output;
  switch (agent) {
    case 'claude':
      return signedInFlag(jsonStatus(text, claudeStatusSchema)?.loggedIn);
    case 'cursor':
      return signedInFlag(jsonStatus(text, cursorStatusSchema)?.isAuthenticated);
    case 'codex':
      // Codex prints its status on stderr and exits 1 when signed out.
      if (/not logged in/iu.test(text)) return 'signed-out';
      return output.exitCode === 0 && /logged in/iu.test(text) ? 'signed-in' : 'unknown';
    case 'opencode': {
      // Exits 0 either way; saved credentials or provider keys in the environment both count.
      const credentials = text.match(/(\d+)\s+credentials?\b/iu);
      const environment = text.match(/(\d+)\s+environment variables?\b/iu);
      if (!credentials && !environment) return 'unknown';
      return Number(credentials?.[1] ?? 0) + Number(environment?.[1] ?? 0) > 0 ? 'signed-in' : 'signed-out';
    }
  }
}

/** The JSON object a status command printed, ignoring any text around it. */
function jsonStatus<Value>(text: string, schema: BoundarySchema<Value>): Value | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  try {
    return decodeOptionalBoundary(JSON.parse(text.slice(start, end + 1)), schema);
  } catch {
    return undefined;
  }
}

function signedInFlag(flag: boolean | undefined): RunpaneAgentSignIn {
  if (flag === undefined) return 'unknown';
  return flag ? 'signed-in' : 'signed-out';
}
