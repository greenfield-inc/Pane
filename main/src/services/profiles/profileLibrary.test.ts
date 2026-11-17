import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIN_SAMPLES_PER_OUTCOME } from '../../../../shared/types/profiles';
import { listProfiles, userProfilesDir } from './profileLibrary';

const REPO = path.join(__dirname, '../../../..');
const FIXTURES = path.join(REPO, 'shared/profiles/fixtures');
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function paneDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pane-profiles-library-'));
  temporary.push(dir);
  return dir;
}

describe('the bundled profiles', () => {
  it('ships greenfield valid, launchable and on, with real samples on every agent outcome', () => {
    const greenfield = listProfiles({ paneDir: paneDir() }).find((profile) => profile.name === 'greenfield');
    expect(greenfield?.errors).toEqual([]);
    expect(greenfield).toMatchObject({ origin: 'bundled', valid: true, launchable: true, enabled: true, version: '1.0.0' });
    const flow = greenfield?.profile?.flow;
    expect(flow?.steps).toHaveLength(11);
    for (const step of flow?.steps ?? []) {
      if (step.kind !== 'agent') continue;
      for (const outcome of step.outcomes) expect(greenfield?.profile?.samples[step.id]?.[outcome.name]?.length).toBeGreaterThanOrEqual(MIN_SAMPLES_PER_OUTCOME);
    }
    expect(Object.keys(greenfield?.profile?.runs ?? {})).toEqual(['A', 'B']);
  });

  it('takes greenfield\'s agents from the bundled Agent Farm plugin', () => {
    const agents = listProfiles({ paneDir: paneDir() }).find((profile) => profile.name === 'greenfield')?.profile?.agents ?? [];
    expect(agents.map((agent) => agent.id)).toEqual(['planner', 'implementer', 'reviewer', 'orchestrator', 'qa-lead']);
    expect(agents.find((agent) => agent.id === 'planner')).toMatchObject({ effort: 'high', reads: ['standing-rules', 'planner-documents', 'planner-identity'] });
    expect(agents.find((agent) => agent.id === 'reviewer')).toMatchObject({ model: 'gpt-6.1-sol', effort: 'max' });
    expect(agents.find((agent) => agent.id === 'orchestrator')?.skills).toContain('orchestrate-sessions');
  });

  it('lists orchestra, bigbrain and machine-security as bundled, team only and off', () => {
    const others = listProfiles({ paneDir: paneDir() }).filter((profile) => profile.name !== 'greenfield');
    expect(others.map((profile) => profile.name).sort()).toEqual(['bigbrain', 'machine-security', 'orchestra']);
    for (const profile of others) {
      expect(profile.errors).toEqual([]);
      expect(profile).toMatchObject({ origin: 'bundled', valid: true, teamOnly: true, launchable: false, enabled: false });
      expect(profile.profile?.agents.length).toBeGreaterThan(0);
    }
  });

  it('turns bundled profiles on and off from config, and lists yours as on', () => {
    const dir = paneDir();
    mkdirSync(userProfilesDir(dir), { recursive: true });
    copyFileSync(path.join(FIXTURES, 'team-only.profile.yaml'), path.join(userProfilesDir(dir), 'team-only.profile.yaml'));
    const profiles = listProfiles({ paneDir: dir, enabled: ['orchestra'] });
    expect(Object.fromEntries(profiles.map((profile) => [profile.name, profile.enabled]))).toEqual({ bigbrain: false, greenfield: false, 'machine-security': false, orchestra: true, 'team-only': true });
    expect(profiles.find((profile) => profile.name === 'team-only')?.origin).toBe('yours');
  });

  it('resolves a bundled profile\'s instruction files only where the plugin is', () => {
    const greenfield = listProfiles({ paneDir: paneDir(), agentFarmPlugins: path.join(paneDir(), 'none') }).find((profile) => profile.name === 'greenfield');
    expect(greenfield?.valid).toBe(false);
    expect(greenfield?.errors.map((error) => error.code)).toContain('READ_MISSING');
  });

  it('matches what the importer writes from the pinned Agent Farm', () => {
    expect(execFileSync(process.execPath, [path.join(REPO, 'scripts/import-agent-farm-profiles.js'), '--check'], { encoding: 'utf8' })).toContain('Up to date');
  });
});
