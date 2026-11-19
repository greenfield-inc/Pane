import fs from 'fs';
import os from 'os';
import path from 'path';
import { divergedCopy, fileDigest } from '../../../../packages/runpane/src/checkedCopy';
import { locateNativeSession, nativeStoreRoot } from '../../../../packages/runpane/src/nativeSession';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { claudeProjectDirName } from '../agentTranscript/claude';
import { isSafePackagePath, type ConversationFile, type ConversationStore, type MoveConversation } from './manifest';
import type { ConversationUndoPlan } from './ledger';

export type ConversationUndo = ConversationUndoPlan;

/**
 * Conversations travel byte for byte (Q-374.4: their history is never rewritten). On the source
 * they are found the way `runpane handoff` finds them; on the target they are filed under its own
 * store, Claude's under the folder for the tab's new working directory, with handoff's divergence
 * guard and exactly one copy per id. Lock files never travel.
 */

const LOCK_FILE = /(?:^|[.-])lock$/i;

function storeRootOf(store: ConversationStore, env: NodeJS.ProcessEnv): string {
  return nativeStoreRoot(store, { ...env, HOME: env.HOME || os.homedir() });
}

/** A conversation's files on this machine, with where each is in the package, or undefined when the store has none. */
export interface LocatedConversation {
  conversation: MoveConversation;
  /** Package path → absolute file here. */
  sources: Map<string, string>;
}

function walk(directory: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : entry.isFile() ? [full] : [];
  });
}

export async function locateConversation(store: ConversationStore, id: string, cwd: string, packagePrefix: string, env: NodeJS.ProcessEnv = process.env): Promise<LocatedConversation | undefined> {
  const located = await locateNativeSession(store, id, cwd, env);
  if (!located) return undefined;
  const root = storeRootOf(store, env);
  const files: ConversationFile[] = [];
  const sources = new Map<string, string>();
  const add = (absolute: string, scope: ConversationFile['scope'], relative: string) => {
    if (LOCK_FILE.test(path.basename(absolute))) return;
    const packagePath = `${packagePrefix}/${scope}/${relative}`;
    files.push({ package: packagePath, scope, relative });
    sources.set(packagePath, absolute);
  };
  for (const file of located.files) {
    const relative = path.relative(root, file.absolute).split(path.sep).join('/');
    if (relative.startsWith('projects/')) {
      // projects/<folder>/<rest>: filed again under the folder for the new working directory.
      add(file.absolute, 'project', relative.split('/').slice(2).join('/'));
    } else {
      add(file.absolute, 'store', relative);
    }
  }
  // Claude's per-session edit history, beside its projects folder (no other store has one).
  for (const file of walk(path.join(root, 'file-history', id))) {
    add(file, 'store', path.relative(root, file).split(path.sep).join('/'));
  }
  return { conversation: { store, id, files }, sources };
}

/**
 * Where a conversation file goes on this machine, for a tab whose working directory is `cwd` here.
 * `relative` comes from the peer's manifest, so it must stay beneath the store: no absolute path,
 * no `..`, and no symlinked folder on the way that leads out of it.
 */
function conversationTarget(store: ConversationStore, file: Pick<ConversationFile, 'scope' | 'relative'>, cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = storeRootOf(store, env);
  const refuse = (why: string) => new PaneError('ERR_MOVE_CONVERSATION_PATH',
    `The package files a conversation at ${file.scope}/${file.relative}, which ${why}, so it was refused.`,
    'Nothing was written. Check that both machines run the same Pane version, then move again.');
  if (!isSafePackagePath(file.relative)) throw refuse(`isn't a plain path inside ${root}`);
  const base = file.scope === 'project' ? path.join(root, 'projects', claudeProjectDirName(cwd)) : root;
  const target = path.join(base, ...file.relative.split('/'));
  if (!isWithin(root, target)) throw refuse(`leads outside ${root}`);
  const existing = deepestExisting(path.dirname(target));
  if (existing && isWithin(root, existing)) {
    const realRoot = fs.realpathSync(root);
    const realExisting = fs.realpathSync(existing);
    if (!isWithin(realRoot, realExisting)) throw refuse(`goes through a symlink to ${realExisting}, outside ${realRoot}`);
  }
  return target;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function deepestExisting(folder: string): string | undefined {
  for (let current = folder; ; current = path.dirname(current)) {
    if (fs.existsSync(current)) return current;
    if (path.dirname(current) === current) return undefined;
  }
}

/** A filed conversation: its main file, and how to take it back out until the move commits. */
export interface PlacedConversation {
  mainPath: string;
  /** Puts back whatever this machine had before (or removes the new copy). */
  undo(): Promise<void>;
  /** Drops the previous copies kept for undo, and any stale copy in another Claude folder. */
  commit(): Promise<void>;
  /** The files `commit` removes, so a start resumed after a restart can remove them too. */
  leftovers: string[];
}

interface Placement {
  source: string;
  target: string;
  staged: string;
  previous: string;
  hadPrevious: boolean;
}

/**
 * Files a conversation from the package into this machine's store. A copy already here is
 * replaced only when the incoming copy holds everything it does; anything continued here after
 * an earlier move is kept and the move refuses. Every file is staged beside its target first,
 * and the swap puts the previous copies back if any rename fails.
 */
export async function placeConversation(
  conversation: MoveConversation,
  packageFile: (packagePath: string) => string,
  cwd: string,
  machine: { here: string; source: string },
  env: NodeJS.ProcessEnv = process.env,
  onPlan?: (plan: ConversationUndo) => void,
): Promise<PlacedConversation> {
  if (conversation.files.length === 0) throw new PaneError('ERR_MOVE_CONVERSATION_EMPTY', `Conversation ${conversation.id} has no files in the package.`, 'Start the move again.');
  let existing: Awaited<ReturnType<typeof locateNativeSession>>;
  try {
    existing = await locateNativeSession(conversation.store, conversation.id, cwd, env);
  } catch (error) {
    throw new PaneError('ERR_MOVE_CONVERSATION_COPIES', `${reasonOf(error)} on ${machine.here}, so the move can't tell which one to replace.`, `Remove the stale copy on ${machine.here}, then move again.`);
  }
  const tag = `pane-move-${Date.now().toString(36)}`;
  const placements: Placement[] = conversation.files.map(file => {
    const target = conversationTarget(conversation.store, file, cwd, env);
    return { source: packageFile(file.package), target, staged: `${target}.${tag}`, previous: `${target}.${tag}.previous`, hadPrevious: fs.existsSync(target) };
  });
  // The divergence guard covers every copy here, in this folder or another Claude folder.
  const here = new Map<string, string>();
  for (const file of existing?.files ?? []) {
    const root = storeRootOf(conversation.store, env);
    const relative = path.relative(root, file.absolute).split(path.sep).join('/');
    const key = relative.startsWith('projects/') ? `project/${relative.split('/').slice(2).join('/')}` : `store/${relative}`;
    here.set(key, file.absolute);
  }
  const diverged: string[] = [];
  for (const file of conversation.files) {
    const current = here.get(`${file.scope}/${file.relative}`);
    if (!current) continue;
    const existingDigest = await fileDigest(current);
    const incoming = packageFile(file.package);
    const incomingBytes = (await fs.promises.stat(incoming)).size;
    const prefix = await fileDigest(incoming, existingDigest.bytes);
    if (divergedCopy(existingDigest, incomingBytes, prefix.sha256)) diverged.push(current);
  }
  if (diverged.length) {
    throw new PaneError('ERR_MOVE_CONVERSATION_DIVERGED',
      `${machine.here}'s copy of conversation ${conversation.id} has history ${machine.source}'s copy doesn't (${diverged.join(', ')}): it was continued there after an earlier move.`,
      `Nothing was copied, so that history is kept. Continue it on ${machine.here}, or move the Session from there instead.`);
  }
  const stale = (existing?.files ?? []).map(file => file.absolute).filter(file => !placements.some(placement => placement.target === file));

  // Folders this move creates go again on undo, so the store looks as it did before.
  const created = [...new Set(placements.map(placement => firstMissingAncestor(path.dirname(placement.target))).filter((folder): folder is string => !!folder))];
  const plan: ConversationUndo = {
    placements: placements.map(({ target, staged, previous, hadPrevious }) => ({ target, staged, previous, hadPrevious })),
    created,
  };
  // Recorded before the store changes, so a restart can still undo it from the plan alone.
  onPlan?.(plan);
  const done: Placement[] = [];
  try {
    for (const placement of placements) {
      await fs.promises.mkdir(path.dirname(placement.target), { recursive: true });
      await fs.promises.copyFile(placement.source, placement.staged);
    }
    for (const placement of placements) {
      if (placement.hadPrevious) await fs.promises.rename(placement.target, placement.previous);
      await fs.promises.rename(placement.staged, placement.target);
      done.push(placement);
    }
  } catch (error) {
    await undoConversationPlacement(plan);
    throw new PaneError('ERR_MOVE_CONVERSATION_PLACE', `Conversation ${conversation.id} couldn't be filed on ${machine.here}: ${reasonOf(error)}. Its store was put back as it was.`, 'Check the disk on that machine, then move again.');
  }
  // One copy per id: a copy in another Claude folder (from an earlier move) goes on commit too.
  const leftovers = [...done.filter(placement => placement.hadPrevious).map(placement => placement.previous), ...stale];
  return {
    mainPath: placements[0].target,
    undo: () => undoConversationPlacement(plan),
    commit: async () => {
      for (const file of leftovers) await fs.promises.rm(file, { force: true });
    },
    leftovers,
  };
}

function firstMissingAncestor(folder: string): string | undefined {
  let missing: string | undefined;
  for (let current = folder; !fs.existsSync(current); current = path.dirname(current)) {
    missing = current;
    if (path.dirname(current) === current) break;
  }
  return missing;
}

/**
 * Puts the store back as it was before a placement, from its plan alone. Safe whether the
 * placement ran fully, partly or not at all, and when run twice: a previous copy that still exists
 * goes back over the new one; a new copy with no previous is removed; staged copies always go.
 */
export async function undoConversationPlacement(plan: ConversationUndo): Promise<void> {
  for (const placement of [...plan.placements].reverse()) {
    await fs.promises.rm(placement.staged, { force: true });
    if (!placement.hadPrevious) {
      await fs.promises.rm(placement.target, { force: true });
    } else if (fs.existsSync(placement.previous)) {
      await fs.promises.rm(placement.target, { force: true });
      await fs.promises.rename(placement.previous, placement.target);
    }
  }
  for (const folder of [...plan.created].sort((x, y) => y.length - x.length)) await fs.promises.rm(folder, { recursive: true, force: true });
}
