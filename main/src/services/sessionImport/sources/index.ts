import type { SessionImportSource } from '../../../../../shared/types/sessionImport';
import type { SourceReader } from './types';
import { readClaudeCode } from './claudeCode';
import { readCodex } from './codex';
import { readConductor } from './conductor';
import { readSuperset } from './superset';
import { readHerdr } from './herdr';
import { readEmdash } from './emdash';
import { readOrca } from './orca';
import { readT3Code } from './t3code';

/** Every tool Pane reads, in the order the card lists them. */
export const SOURCE_READERS: ReadonlyArray<{ source: SessionImportSource; read: SourceReader }> = [
  { source: 'claude', read: readClaudeCode },
  { source: 'codex', read: readCodex },
  { source: 'conductor', read: readConductor },
  { source: 'superset', read: readSuperset },
  { source: 'herdr', read: readHerdr },
  { source: 'emdash', read: readEmdash },
  { source: 'orca', read: readOrca },
  { source: 't3code', read: readT3Code },
];
