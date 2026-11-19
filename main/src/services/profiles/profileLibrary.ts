import { existsSync, readdirSync } from 'fs';
import path from 'path';
import type { LibraryProfile } from '../../../../shared/types/profiles';
import { bundledAgentFarm } from '../agentFarm/bundledAgentFarm';
import { findProfileFiles, loadProfiles, type ProfileSource } from './profileLoader';

/** The profiles Pane ships (copied next to the compiled main by `copy:assets`). */
const BUNDLED_PROFILES_DIR = path.join(__dirname, 'bundled');
/** Bundled profiles that are on when config names none. */
const DEFAULT_ENABLED_PROFILES: readonly string[] = ['greenfield'];

export interface ProfileLibraryOptions {
  paneDir: string;
  /** Config `profiles.enabled`; absent means DEFAULT_ENABLED_PROFILES. */
  enabled?: readonly string[];
  bundledDir?: string;
  /** The bundled Agent Farm's `plugins/` folder, where a bundled profile's instruction files and skills live. */
  agentFarmPlugins?: string;
}

/** The person's own profiles: `<PANE_DIR>/profiles/*.profile.yaml`. */
export function userProfilesDir(paneDir: string): string {
  return path.join(paneDir, 'profiles');
}

function defaultAgentFarmPlugins(): string | undefined {
  const bundle = bundledAgentFarm();
  return bundle ? path.join(bundle.root, 'plugins') : undefined;
}

/** Folders whose `skills/<name>/SKILL.md` count as installed skills. */
function skillFolders(agentFarmPlugins: string | undefined, userDir: string): string[] {
  const folders = [path.join(userDir, 'skills')];
  if (agentFarmPlugins && existsSync(agentFarmPlugins)) {
    for (const plugin of readdirSync(agentFarmPlugins)) folders.push(path.join(agentFarmPlugins, plugin, 'skills'));
  }
  return folders;
}

/**
 * Every profile Pane knows: the bundled ones (whose `reads` and skills resolve in the bundled
 * Agent Farm plugin of the same name, referenced, not copied) and the person's own, each valid
 * or invalid with its errors, and on or off.
 */
export function listProfiles(options: ProfileLibraryOptions): LibraryProfile[] {
  const plugins = options.agentFarmPlugins ?? defaultAgentFarmPlugins();
  const userDir = userProfilesDir(options.paneDir);
  const bundled: ProfileSource[] = findProfileFiles(options.bundledDir ?? BUNDLED_PROFILES_DIR, 'bundled').map((source) => {
    // <plugin>.profile.yaml or <plugin>.<profile>.profile.yaml: its files live in that Agent Farm plugin.
    const plugin = plugins ? path.join(plugins, path.basename(source.file).split('.')[0]) : undefined;
    return plugin && existsSync(plugin) ? { ...source, filesRoot: plugin } : source;
  });
  const folders = skillFolders(plugins, userDir);
  const skillExists = (name: string) => folders.some((folder) => existsSync(path.join(folder, name, 'SKILL.md')));
  const enabled = new Set(options.enabled ?? DEFAULT_ENABLED_PROFILES);
  return loadProfiles([...bundled, ...findProfileFiles(userDir, 'yours')], { skillExists })
    .map((profile) => ({ ...profile, enabled: profile.origin === 'yours' || enabled.has(profile.name) }));
}
