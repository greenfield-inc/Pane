import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

const SKILL_NAME = 'pane-manage-and-message-agents';
const SOURCE = path.join(__dirname, 'userSkills', SKILL_NAME, 'SKILL.md');
const MARKER = '.pane-managed';

export interface UserSkillTarget {
  client: 'Claude Code' | 'Codex' | 'Cursor';
  skillsRoot: string;
}

export async function syncPaneUserSkills(targets: UserSkillTarget[], enabled: boolean): Promise<void> {
  const source = enabled ? await fs.readFile(SOURCE) : undefined;
  for (const target of targets) {
    try {
      await syncSkill(target.skillsRoot, source);
    } catch (error) {
      console.warn(`[PaneMcp] ${target.client} user skill sync failed:`, error);
    }
  }
}

async function syncSkill(root: string, source: Buffer | undefined): Promise<void> {
  const folder = path.join(root, SKILL_NAME);
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
