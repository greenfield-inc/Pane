import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { flowEdges } from '../../../../shared/profiles/flowGraph';
import { PROFILE_END } from '../../../../shared/types/profiles';
import { findProfileFiles, loadProfiles, type ProfileSource } from './profileLoader';

const FIXTURES = join(__dirname, '../../../../shared/profiles/fixtures');
const INVALID = join(FIXTURES, 'invalid');

function fixture(name: string, origin: ProfileSource['origin'] = 'bundled'): ProfileSource {
  return { file: join(FIXTURES, `${name}.profile.yaml`), origin };
}

function greenfield() {
  const [loaded] = loadProfiles([fixture('greenfield')], { skillExists: (name) => name === 'orchestrate-sessions' });
  return loaded;
}

describe('loadProfiles: greenfield', () => {
  it('loads greenfield as valid and launchable', () => {
    const loaded = greenfield();
    expect(loaded.errors).toEqual([]);
    expect(loaded).toMatchObject({ name: 'greenfield', version: '1.0.0', valid: true, launchable: true, teamOnly: false });
  });

  it('keeps every step and edge of the file, in order', () => {
    const flow = greenfield().profile?.flow;
    expect(flow?.start).toBe('plan');
    expect(flow?.steps.map((step) => step.id)).toEqual(['plan', 'answer', 'approve', 'build', 'unblock', 'checks', 'review', 'triage', 'merge', 'qa', 'merged']);
    const edges = flow ? flowEdges(flow) : [];
    // 2 per agent step (5), 2 per command with outcomes (1), 2 per choice ask (2), 1 per next ask (2).
    expect(edges).toHaveLength(5 * 2 + 2 + 2 * 2 + 2);
    expect(edges.filter((edge) => edge.chooser === 'you').map((edge) => `${edge.from}→${edge.to}`)).toEqual(['answer→plan', 'approve→build', 'approve→plan', 'unblock→build', 'merge→merged', 'merge→qa']);
    expect(edges.every((edge) => edge.to !== PROFILE_END)).toBe(true);
  });

  it('reads agents as cli and model', () => {
    const agents = greenfield().profile?.agents ?? [];
    expect(agents.map((agent) => agent.id)).toEqual(['planner', 'implementer', 'reviewer', 'orchestrator', 'qa-lead']);
    expect(agents[2]).toMatchObject({ cli: 'codex', model: 'gpt-6.1-sol', reads: ['standing-rules'] });
    expect(agents[3].skills).toEqual(['orchestrate-sessions']);
  });

  it('gives command steps their title and agent steps their agent as the label', () => {
    const steps = greenfield().profile?.flow?.steps ?? [];
    expect(steps.find((step) => step.id === 'checks')).toMatchObject({ kind: 'command', title: 'CI + QA checks', run: 'gh pr checks --watch' });
    expect(steps.find((step) => step.id === 'merged')).toMatchObject({ kind: 'command', title: 'gh pr merge --merge', outcomes: [] });
    expect(steps.find((step) => step.id === 'plan')).toMatchObject({ kind: 'agent', title: 'planner' });
  });

  it('reads both example runs, with sample numbers and the typed answer', () => {
    const runs = greenfield().profile?.runs ?? {};
    expect(runs.A).toHaveLength(7);
    expect(runs.A[0]).toEqual({ step: 'plan', took: 'plan ready', sample: 1 });
    expect(runs.A[6]).toEqual({ step: 'merged' });
    expect(runs.B).toHaveLength(17);
    expect(runs.B[1]).toEqual({ step: 'answer', answer: 'Exclude refunds; they have their own report.' });
    expect(runs.B[13]).toEqual({ step: 'merge', took: 'QA first' });
  });

  it('flags a skill that is not installed', () => {
    const [loaded] = loadProfiles([fixture('greenfield')], { skillExists: () => false });
    expect(loaded.valid).toBe(false);
    expect(loaded.errors.map((error) => error.code)).toEqual(['SKILL_MISSING']);
  });
});

describe('loadProfiles: one broken fixture per rule', () => {
  const files = readdirSync(INVALID).filter((file) => file.endsWith('.profile.yaml'));

  it('has a fixture for each rule', () => {
    expect(files.length).toBeGreaterThanOrEqual(19);
  });

  it.each(files)('%s is invalid with the error its header names', (file) => {
    const expected = /^# expect: (\S+)/u.exec(readFileSync(join(INVALID, file), 'utf8'))?.[1];
    const [loaded] = loadProfiles([{ file: join(INVALID, file), origin: 'yours' }]);
    expect(loaded.valid).toBe(false);
    expect(loaded.launchable).toBe(false);
    expect(loaded.errors.map((error) => error.code)).toContain(expected);
    for (const error of loaded.errors) {
      expect(error.message).not.toBe('');
      expect(error.fix).not.toBe('');
    }
  });

  it('names the step and outcome of a sample shortfall, in the plan\'s words', () => {
    const [loaded] = loadProfiles([{ file: join(INVALID, 'one-sample.profile.yaml'), origin: 'yours' }]);
    expect(loaded.errors).toEqual([expect.objectContaining({
      code: 'SAMPLES_TOO_FEW',
      step: 'draft',
      outcome: 'stuck',
      message: 'Step draft, outcome stuck has 1 sample. Every outcome of an agent step needs at least 2, so its picture can show how results vary.',
    })]);
  });
});

describe('loadProfiles: team-only, overlays, duplicates and unreadable files', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function tempProfile(name: string, body: string): ProfileSource {
    dir ??= mkdtempSync(join(tmpdir(), 'pane-profiles-'));
    const file = join(dir, `${name}.profile.yaml`);
    writeFileSync(file, body);
    return { file, origin: 'yours' };
  }

  it('lists a profile without a flow as team only: valid, not launchable', () => {
    const [loaded] = loadProfiles([fixture('team-only')]);
    expect(loaded).toMatchObject({ valid: true, teamOnly: true, launchable: false, errors: [] });
    expect(loaded.profile?.agents[1]).toMatchObject({ cli: 'some-new-cli' });
    expect(loaded.profile?.agents[1].model).toBeUndefined();
  });

  it('applies an overlay to the profile it extends and validates the result', () => {
    const [, mine] = loadProfiles([fixture('greenfield'), fixture('greenfield-mine', 'yours')]);
    expect(mine.errors).toEqual([]);
    expect(mine).toMatchObject({ name: 'greenfield-mine', valid: true, launchable: true, origin: 'yours' });
    const reviewer = mine.profile?.agents.find((agent) => agent.id === 'reviewer');
    expect(reviewer).toMatchObject({ cli: 'claude', reads: ['standing-rules'] });
    expect(mine.profile?.flow?.steps).toHaveLength(11);
    expect(mine.profile?.extends).toBe('greenfield@^1.0');
    // Its agents' reads resolve in its own folder first, then in greenfield's.
    expect(mine.readsRoots).toEqual([FIXTURES, FIXTURES]);
  });

  it('resolves an overlay\'s inherited reads in its base\'s folder', () => {
    const overlay = tempProfile('elsewhere', 'format: pane-profile/1\nname: elsewhere\nversion: 1.0.0\nextends: greenfield@^1\n');
    const [, loaded] = loadProfiles([fixture('greenfield'), overlay], { skillExists: () => true });
    expect(loaded.errors).toEqual([]);
    expect(loaded.readsRoots).toEqual([dir, FIXTURES]);
  });

  it('refuses YAML aliases quickly, so a nested-alias file can\'t exhaust memory', () => {
    const levels = ['a: &a ["x","x","x","x","x","x","x","x","x"]'];
    for (let index = 1; index <= 9; index += 1) {
      levels.push(`${String.fromCharCode(97 + index)}: &${String.fromCharCode(97 + index)} [${Array(9).fill(`*${String.fromCharCode(96 + index)}`).join(',')}]`);
    }
    const bomb = tempProfile('bomb', `format: pane-profile/1\nname: bomb\nversion: 1.0.0\n${levels.join('\n')}\n`);
    const started = Date.now();
    const [loaded] = loadProfiles([bomb]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(loaded).toMatchObject({ name: 'bomb', valid: false });
    expect(loaded.errors.map((error) => error.code)).toEqual(['PROFILE_YAML_ALIAS']);
  });

  it('reads a block list of inline maps and lists, which are not aliases', () => {
    const inline = tempProfile('inline', [
      'format: pane-profile/1', 'name: inline', 'version: 1.0.0',
      'agents:', '  writer: { runs: claude, skills: [a, b] }',
      'flow:', '  start: draft', '  draft: { agent: writer, goal: Draft it, outcomes: { done: end, stuck: end } }',
      'samples:', '  draft:', '    done: ["Drafted.", "Drafted, with notes."]', '    stuck: ["Stuck.", "Stuck again."]',
      'runs:', '  A:', '    - { draft: "done #1" }', '  B:', '    - { draft: "stuck #2" }',
      '',
    ].join('\n'));
    const [loaded] = loadProfiles([inline], { skillExists: () => true });
    expect(loaded.errors).toEqual([]);
    expect(loaded.profile?.runs.A).toEqual([{ step: 'draft', took: 'done', sample: 1 }]);
  });

  it('refuses a file too large to be a profile, unread', () => {
    const huge = tempProfile('huge', `format: pane-profile/1\nname: huge\nversion: 1.0.0\ndescription: "${'x'.repeat(600 * 1024)}"\n`);
    expect(loadProfiles([huge])[0].errors.map((error) => error.code)).toEqual(['PROFILE_TOO_LARGE']);
  });

  it('flags a misspelt key instead of dropping it', () => {
    const typo = tempProfile('typo', 'format: pane-profile/1\nname: typo\nversion: 1.0.0\nagents:\n  a: { runs: claude }\nflwo:\n  start: s\n');
    const [loaded] = loadProfiles([typo]);
    expect(loaded.valid).toBe(false);
    expect(loaded.errors).toEqual([expect.objectContaining({ code: 'UNKNOWN_KEY', message: 'The profile has "flwo:", which Pane doesn\'t read.' })]);
  });

  it('refuses a reads id that leaves the profile\'s folder', () => {
    const escape = tempProfile('escape', 'format: pane-profile/1\nname: escape\nversion: 1.0.0\nagents:\n  a: { runs: claude, reads: [../outside] }\n');
    expect(loadProfiles([escape])[0].errors.map((error) => error.code)).toEqual(['READ_ID']);
  });

  it('refuses an overlay whose range excludes the installed version', () => {
    const overlay = tempProfile('later', 'format: pane-profile/1\nname: later\nversion: 1.0.0\nextends: greenfield@^2\n');
    const [, loaded] = loadProfiles([fixture('greenfield'), overlay]);
    expect(loaded.errors.map((error) => error.code)).toEqual(['EXTENDS_VERSION']);
  });

  it('refuses an overlay of a profile that is not installed', () => {
    const overlay = tempProfile('lonely', 'format: pane-profile/1\nname: lonely\nversion: 1.0.0\nextends: orchestra@^1\n');
    const [loaded] = loadProfiles([overlay]);
    expect(loaded.errors.map((error) => error.code)).toEqual(['EXTENDS_MISSING']);
  });

  it('removes a step when the overlay sets it to null, then validates the merge', () => {
    const overlay = tempProfile('no-qa', 'format: pane-profile/1\nname: no-qa\nversion: 1.0.0\nextends: greenfield\nflow:\n  qa: null\n');
    const [, loaded] = loadProfiles([fixture('greenfield'), overlay]);
    expect(loaded.valid).toBe(false);
    expect(loaded.errors).toContainEqual(expect.objectContaining({ code: 'EDGE_TARGET_MISSING', step: 'merge', outcome: 'QA first' }));
  });

  it('keeps the first of two profiles with one name', () => {
    const copy = tempProfile('greenfield', readFileSync(join(FIXTURES, 'greenfield.profile.yaml'), 'utf8'));
    const [first, second] = loadProfiles([fixture('greenfield'), copy]);
    expect(first.valid).toBe(true);
    expect(second.errors.map((error) => error.code)).toEqual(['PROFILE_DUPLICATE']);
  });

  it('reports YAML that does not parse, with the file name', () => {
    const broken = tempProfile('broken', 'format: pane-profile/1\nname: [unclosed\n');
    const [loaded] = loadProfiles([broken]);
    expect(loaded).toMatchObject({ name: 'broken', valid: false });
    expect(loaded.errors[0].code).toBe('PROFILE_YAML');
    expect(loaded.errors[0].message).toMatch(/^broken\.profile\.yaml is not valid YAML: .+ at line \d+\.$/u);
  });

  it('finds only *.profile.yaml files, and none in a missing folder', () => {
    expect(findProfileFiles(join(FIXTURES, 'nowhere'), 'yours')).toEqual([]);
    expect(findProfileFiles(join(FIXTURES, 'greenfield.profile.yaml'), 'yours')).toEqual([]);
    expect(findProfileFiles(FIXTURES, 'bundled').map((source) => source.file.replace(/\\/gu, '/').split('/').pop())).toEqual(['greenfield-mine.profile.yaml', 'greenfield.profile.yaml', 'team-only.profile.yaml']);
  });
});
