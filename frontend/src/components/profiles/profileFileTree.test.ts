import { describe, expect, it } from 'vitest';
import { fileTreeRows } from './profileFileTree';

describe('fileTreeRows', () => {
  it('shows plugin.yaml, then each section with its hint, folders before files, nested skills and references', () => {
    const rows = fileTreeRows(['skills/plan/SKILL.md', 'agents/writer.md', 'plugin.yaml', 'references/writer/tone.md', 'profiles/writer.yaml', 'agents/editor.md', 'skills/plan/notes/a.md']);
    expect(rows.map(row => `${'  '.repeat(row.depth)}${row.kind === 'folder' ? `${row.name}/` : row.name}${row.kind === 'folder' && row.hint ? ` (${row.hint})` : ''}`)).toEqual([
      'plugin.yaml',
      'profiles/ (Profile settings)',
      '  writer.yaml',
      'agents/ (Identity & subagents)',
      '  editor.md',
      '  writer.md',
      'skills/ (Skills)',
      '  plan/',
      '    notes/',
      '      a.md',
      '    SKILL.md',
      'references/ (References)',
      '  writer/',
      '    tone.md',
    ]);
    expect(rows.find(row => row.name === 'a.md')?.path).toBe('skills/plan/notes/a.md');
  });
});
