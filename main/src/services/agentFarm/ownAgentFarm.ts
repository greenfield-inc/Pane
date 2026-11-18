import { execFile } from 'child_process';
import { promisify } from 'util';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { getShellPath } from '../../utils/shellPath';
import { agentFarmCommand } from '../chatTabs/agentFarm';

const execFileAsync = promisify(execFile);

/** One profile from the person's own Agent Farm, as `agent-farm profiles list` prints it. */
export interface OwnAgentFarmProfile {
  /** Qualified (`plugin/profile`) or local name; what `agent-farm run` takes. */
  name: string;
  /** `plugin <name> <version>`, or `local` (which Agent Farm prints as `plugin local -`). */
  source: string;
  harness?: string;
  model?: string;
}

/**
 * Reads `agent-farm profiles list` lines such as
 * `greenfield/planner (claude: … · codex: …) -> planner | plugin greenfield 0.0.46 | claude | claude-opus-5-5 high | native default`.
 */
export function parseOwnAgentFarmProfiles(stdout: string): OwnAgentFarmProfile[] {
  const profiles: OwnAgentFarmProfile[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const fields = line.split(' | ').map((field) => field.trim());
    const name = /^([A-Za-z0-9_][\w./:-]*)(?:\s|$)/u.exec(fields[0] ?? '')?.[1];
    if (!name || fields.length < 2) continue;
    const profile: OwnAgentFarmProfile = { name, source: /^plugin local\b/u.test(fields[1]) ? 'local' : fields[1] };
    if (fields[2]) profile.harness = fields[2];
    if (fields[3]) profile.model = fields[3];
    profiles.push(profile);
  }
  return profiles;
}

/**
 * The person's own Agent Farm profiles, read with their own agent-farm and its default config
 * root: read-only, so their install and ~/.config/agent-farm stay exactly as they are. It runs
 * with the login shell's PATH, because an npm-installed agent-farm starts with `env node`.
 */
export async function listOwnAgentFarmProfiles(executable: string): Promise<OwnAgentFarmProfile[]> {
  const command = agentFarmCommand(executable, ['profiles', 'list']);
  try {
    const { stdout } = await execFileAsync(command.executable, command.args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments, env: { ...process.env, PATH: getShellPath(), NO_COLOR: '1' } });
    return parseOwnAgentFarmProfiles(stdout);
  } catch (error) {
    throw new PaneError('AGENT_FARM_LIST_FAILED', `Pane couldn't list your Agent Farm profiles with ${executable}: ${reasonOf(error)}.`, `Run \`agent-farm profiles list\` in a terminal to see why, then reopen Profiles.`);
  }
}
