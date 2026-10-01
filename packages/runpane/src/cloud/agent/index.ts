import { AGENT_GITHUB_USAGE, runAgentGitHub } from './github';
import { runDopplerStandIn } from './doppler';
import { runGhShim } from './ghShim';
import { runGitCredential } from './gitCredential';
import { defaultAgentDeps, type AgentDeps } from './session';

/**
 * `runpane cloud agent ...`: the commands that run INSIDE a cloud Session and talk only to the
 * coordinator. They need none of the laptop's `runpane cloud` state or keys.
 *   github ...        runpane cloud agent github push|pr|issue|read|status
 *   gh ...            the gh compatibility shim (~/.local/bin/gh runs this)
 *   git-credential    the git credential helper (~/.local/bin/git-credential-runpane runs this)
 *   doppler ...       the doppler stand-in (~/.local/bin/doppler runs this): manifest secrets from the coordinator
 */
export async function runCloudAgent(argv: readonly string[], deps: AgentDeps = defaultAgentDeps()): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'github': return runAgentGitHub(rest, deps);
    case 'gh': return runGhShim(rest, deps);
    case 'git-credential': return runGitCredential(rest, deps);
    case 'doppler': return runDopplerStandIn(rest, deps);
    default:
      deps.stdout(AGENT_GITHUB_USAGE);
      return command === undefined || command === '--help' || command === '-h' ? 0 : 1;
  }
}
