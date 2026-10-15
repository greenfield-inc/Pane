import { PaneError, reasonOf } from '../../../shared/paneError';
import {
  projectEnvKeyProblem,
  type ProjectEnvVar,
  type ProjectEnvVarInput,
} from '../../../shared/types/projectEnvVars';
import type { DatabaseService } from '../database/database';
import { getAppDirectory } from '../utils/appDirectory';
import { keychainUnsupportedError, paneKeychainAccount, paneKeychainService, systemKeychain, type Keychain } from './keychain';

/** A project's variables, ready to merge into a child process environment. */
export interface ResolvedProjectEnv {
  env: Record<string, string>;
  /** One sentence per variable that was skipped. Never contains a value. */
  warnings: string[];
}

type ProjectEnvStore = Pick<DatabaseService, 'getProjectEnvVars' | 'replaceProjectEnvVars' | 'getSession'>;

const SETTINGS_STEP = 'Open Project Settings → Environment Variables and correct it.';

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
    /** Service of the items Pane creates; see `paneKeychainService`. */
    private readonly keychainService: string = paneKeychainService(getAppDirectory()),
  ) {}

  list(projectId: number): ProjectEnvVar[] {
    return this.store.getProjectEnvVars(projectId);
  }

  /**
   * Replace the project's variables. A typed secret goes to Pane's own keychain item
   * and only its reference is stored. Pane's items that no variable references any
   * more are deleted from the keychain.
   */
  async save(projectId: number, inputs: readonly ProjectEnvVarInput[]): Promise<ProjectEnvVar[]> {
    const seen = new Set<string>();
    for (const input of inputs) {
      const problem = projectEnvKeyProblem(input.key);
      if (problem) throw invalid(problem);
      if (seen.has(input.key)) throw invalid(`${input.key} is defined twice.`);
      seen.add(input.key);
      if (input.source === 'keychain' && !('secret' in input) && (!input.service.trim() || !input.account.trim())) {
        throw invalid(`${input.key} needs both a keychain service and an account.`);
      }
      if (input.source === 'keychain' && 'secret' in input && !input.secret) {
        throw invalid(`${input.key} needs a secret value.`);
      }
    }

    const keychain = this.keychain();
    if (!keychain.supported && inputs.some(input => input.source === 'keychain')) {
      throw keychainUnsupportedError();
    }

    // An item stays Pane's own while a variable still points at it, even after a rename.
    const previous = this.store.getProjectEnvVars(projectId);
    const ownItems = new Set(previous.flatMap(old =>
      old.source === 'keychain' && old.managed ? [`${old.service}\u0000${old.account}`] : []));

    const variables: ProjectEnvVar[] = [];
    for (const input of inputs) {
      if (input.source === 'plain') {
        variables.push({ key: input.key, source: 'plain', value: input.value });
        continue;
      }
      if ('secret' in input) {
        const account = paneKeychainAccount(projectId, input.key);
        try {
          await keychain.write(this.keychainService, account, input.secret);
        } catch (error) {
          throw new PaneError(
            'KEYCHAIN_WRITE_FAILED',
            `Pane could not store ${input.key} in ${itemName(this.keychainService, account)}: ${reasonOf(error)}. Nothing was saved.`,
            'Unlock the login keychain in Keychain Access, then save Project Settings again.',
          );
        }
        variables.push({ key: input.key, source: 'keychain', service: this.keychainService, account, managed: true });
        continue;
      }
      const service = input.service.trim();
      const account = input.account.trim();
      variables.push({ key: input.key, source: 'keychain', service, account, managed: ownItems.has(`${service}\u0000${account}`) });
    }

    this.store.replaceProjectEnvVars(projectId, variables);

    const stillReferenced = new Set(variables.flatMap(variable =>
      variable.source === 'keychain' ? [`${variable.service}\u0000${variable.account}`] : []));
    for (const old of previous) {
      if (old.source !== 'keychain' || !old.managed || stillReferenced.has(`${old.service}\u0000${old.account}`)) continue;
      await keychain.remove(old.service, old.account).catch(error => {
        console.warn(`[ProjectEnv] Could not delete unused ${itemName(old.service, old.account)}: ${reasonOf(error)}`);
      });
    }

    return this.store.getProjectEnvVars(projectId);
  }

  /** Remove all of the project's variables and Pane's keychain items for them. */
  async clear(projectId: number): Promise<void> {
    await this.save(projectId, []);
  }

  /** Read every variable of the project. A keychain item that cannot be read is skipped with a warning. */
  async resolve(projectId: number): Promise<ResolvedProjectEnv> {
    const env: Record<string, string> = {};
    const warnings: string[] = [];
    const variables = this.store.getProjectEnvVars(projectId);
    if (variables.length === 0) return { env, warnings };
    const keychain = this.keychain();

    await Promise.all(variables.map(async variable => {
      if (variable.source === 'plain') {
        env[variable.key] = variable.value;
        return;
      }
      try {
        if (!keychain.supported) throw keychainUnsupportedError();
        env[variable.key] = await keychain.read(variable.service, variable.account);
      } catch (error) {
        warnings.push(
          `Pane did not set ${variable.key}: it could not read ${itemName(variable.service, variable.account)} (${reasonOf(error)}). `
          + `Everything else started normally. Fix the item in Keychain Access, or change the variable in Project Settings → Environment Variables.`,
        );
      }
    }));

    // Keep the project's order regardless of which keychain read finished first.
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
