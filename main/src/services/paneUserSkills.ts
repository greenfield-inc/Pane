import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

const AGENTS_SKILL = 'pane-manage-and-message-agents';
export const COMPUTER_USE_SKILL = 'pane-computer-use';
const MARKER = '.pane-managed';

export interface UserSkillTarget {
  client: 'Claude Code' | 'Codex' | 'Cursor';
  skillsRoot: string;
}

/** Installs or removes one bundled skill (`userSkills/<skillName>/SKILL.md`) for each client. */
export async function syncPaneUserSkills(targets: UserSkillTarget[], enabled: boolean, skillName = AGENTS_SKILL): Promise<void> {
  const source = enabled ? await fs.readFile(path.join(__dirname, 'userSkills', skillName, 'SKILL.md')) : undefined;
  for (const target of targets) {
    try {
      await syncSkill(target.skillsRoot, skillName, source);
    } catch (error) {
      console.warn(`[PaneMcp] ${target.client} user skill sync failed:`, error);
    }
  }
}

async function syncSkill(root: string, skillName: string, source: Buffer | undefined): Promise<void> {
  const folder = path.join(root, skillName);
  const file = path.join(folder, 'SKILL.md');
  const markerFile = path.join(folder, MARKER);
  const marker = await fs.readFile(markerFile, 'utf8').catch(missingOnly);
  if (marker === undefined) {
    if (!source || await fs.lstat(folder).then(() => true, missingOnly) === true) return;
    await fs.mkdir(folder, { recursive: true });
    await writeAtomic(file, source);
    await writeAtomic(markerFile, digest(source));
    return;
  }
  const current = await fs.readFile(file).catch(missingOnly);
  if (!current || digest(current) !== marker) return;
  if (!source) {
    await fs.rm(file);
    await fs.rm(markerFile);
    await fs.rmdir(folder).catch((error) => {
      if (!isCode(error, 'ENOTEMPTY')) throw error;
    });
  } else if (!current.equals(source)) {
    await writeAtomic(file, source);
    await writeAtomic(markerFile, digest(source));
  }
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isCode(error: NodeJS.ErrnoException, code: string): boolean {
  return decodeOptionalBoundary(error, boundary.object({ code: boundary.string }))?.code === code;
}

function missingOnly(error: NodeJS.ErrnoException): undefined {
  if (isCode(error, 'ENOENT')) return undefined;
  throw error;
}

async function writeAtomic(file: string, content: string | Buffer): Promise<void> {
  const target = await fs.realpath(file).catch((error) => {
    if (isCode(error, 'ENOENT')) return file;
    throw error;
  });
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, content);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}
