import { PaneError, reasonOf } from '../../../shared/paneError';
import {
  projectEnvKeyProblem,
  type ProjectEnvVar,
  type ProjectEnvVarInput,
} from '../../../shared/types/projectEnvVars';
import type { DatabaseService } from '../database/database';
import { teammatePaneCaller } from '../daemon/commandRegistry';
import { keychainUnsupportedError, systemKeychain, type Keychain } from './keychain';
import { teammateSecretRefusal } from '../../../shared/types/paneSecrets';
import { paneSecretStore, validatePaneSecretAddress, type PaneSecretStore } from './paneSecrets';

/** A project's variables, ready to merge into a child process environment. */
export interface ResolvedProjectEnv {
  env: Record<string, string>;
  /** One sentence per variable that was skipped. Never contains a value. */
  warnings: string[];
}

type ProjectEnvStore = Pick<DatabaseService, 'getProjectEnvVars' | 'replaceProjectEnvVars' | 'getSession'>;

const SETTINGS_STEP = 'Correct it in Project Settings → Environment Variables, or with `runpane repos update --env`.';

function invalid(message: string): PaneError {
  return new PaneError('PROJECT_ENV_INVALID', `${message} Nothing was saved.`, SETTINGS_STEP);
}

function itemName(service: string, account: string): string {
  return `keychain item "${service}" / "${account}"`;
}

/** Stores, resolves and validates per-project environment variables. */
export class ProjectEnvService {
  constructor(
    private readonly store: ProjectEnvStore,
    private readonly keychain: () => Keychain = systemKeychain,
    private readonly secrets: () => Pick<PaneSecretStore, 'set' | 'read'> = paneSecretStore,
  ) {}

  list(projectId: number): ProjectEnvVar[] {
    return this.store.getProjectEnvVars(projectId);
  }

  /**
   * Replace the project's variables. A Pane secret variable that carries a value
   * creates or replaces that secret first; only its address is stored here. A dry run
   * checks everything and returns what would be saved, writing nothing.
   */
  async save(projectId: number, inputs: readonly ProjectEnvVarInput[], options: { dryRun?: boolean } = {}): Promise<ProjectEnvVar[]> {
    const seen = new Set<string>();
    for (const input of inputs) {
      const problem = projectEnvKeyProblem(input.key);
      if (problem) throw invalid(problem);
      if (seen.has(input.key)) throw invalid(`${input.key} is defined twice.`);
      seen.add(input.key);
      if (input.source === 'keychain' && (!input.service.trim() || !input.account.trim())) {
        throw invalid(`${input.key} needs both a keychain service and an account.`);
      }
      if (input.source === 'secret') {
        try {
          validatePaneSecretAddress(input.project.trim(), input.name.trim());
        } catch (error) {
          throw invalid(`${input.key}: ${reasonOf(error)}.`);
        }
      }
    }
    if (!this.keychain().supported && inputs.some(input => input.source === 'keychain')) {
      throw keychainUnsupportedError();
    }

    const variables: ProjectEnvVar[] = inputs.map((input): ProjectEnvVar => {
      if (input.source === 'plain') return { key: input.key, source: 'plain', value: input.value };
      if (input.source === 'keychain') return { key: input.key, source: 'keychain', service: input.service.trim(), account: input.account.trim() };
      return { key: input.key, source: 'secret', project: input.project.trim(), name: input.name.trim() };
    });
    const teammate = teammatePaneCaller();
    if (teammate) {
      // A teammate keeps the owner's secret variables as they are but adds or changes none:
      // either would let their terminals read a secret, or overwrite one.
      const current = new Map(this.store.getProjectEnvVars(projectId).map(variable => [variable.key, JSON.stringify(variable)]));
      const touchesSecret = inputs.some(input => input.source === 'secret' && input.value)
        || variables.some(variable => variable.source !== 'plain' && current.get(variable.key) !== JSON.stringify(variable));
      if (touchesSecret) throw teammateSecretRefusal(teammate, 'add or change a Pane secret or keychain variable');
    }
    if (options.dryRun) return variables;
    // Secrets first, so a failed write leaves the project's variables as they were.
    for (const input of inputs) {
      if (input.source === 'secret' && input.value) await this.secrets().set(input.project.trim(), input.name.trim(), input.value);
    }
    this.store.replaceProjectEnvVars(projectId, variables);
    return this.store.getProjectEnvVars(projectId);
  }

  /** Remove all of the project's variables. Pane secrets they pointed at stay. */
  async clear(projectId: number): Promise<void> {
    this.store.replaceProjectEnvVars(projectId, []);
  }

  /** Read every variable of the project. A value that cannot be read is skipped with a warning. */
  async resolve(projectId: number): Promise<ResolvedProjectEnv> {
    const env: Record<string, string> = {};
    const warnings: string[] = [];
    const variables = this.store.getProjectEnvVars(projectId);
    if (variables.length === 0) return { env, warnings };

    await Promise.all(variables.map(async variable => {
      if (variable.source === 'plain') {
        env[variable.key] = variable.value;
        return;
      }
      const teammate = teammatePaneCaller();
      if (teammate) {
        warnings.push(`Pane did not set ${variable.key}: ${teammate} started this, and only this computer's owner can use its secrets. Everything else started normally.`);
        return;
      }
      if (variable.source === 'secret') {
        try {
          env[variable.key] = await this.secrets().read(variable.project, variable.name);
        } catch (error) {
          warnings.push(
            `Pane did not set ${variable.key}: it could not read Pane secret ${variable.project}/${variable.name} (${reasonOf(error)}). `
            + 'Everything else started normally. Set it in Settings → Secrets or with `runpane secrets set`, or change the variable in Project Settings → Environment Variables.',
          );
        }
        return;
      }
      try {
        const keychain = this.keychain();
        if (!keychain.supported) throw keychainUnsupportedError();
        env[variable.key] = await keychain.read(variable.service, variable.account);
      } catch (error) {
        warnings.push(
          `Pane did not set ${variable.key}: it could not read ${itemName(variable.service, variable.account)} (${reasonOf(error)}). `
          + `Everything else started normally. Fix the item in Keychain Access, or change the variable in Project Settings → Environment Variables.`,
        );
      }
    }));

    // Keep the project's order regardless of which read finished first.
    const ordered: Record<string, string> = {};
    for (const variable of variables) {
      if (variable.key in env) ordered[variable.key] = env[variable.key];
    }
    return { env: ordered, warnings };
  }

  /** The variables of the project that owns this Pane, or none for a Pane outside any project. */
  async resolveForSession(sessionId: string): Promise<ResolvedProjectEnv> {
    const projectId = this.store.getSession(sessionId)?.project_id;
    return projectId ? this.resolve(projectId) : { env: {}, warnings: [] };
  }
}
