import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Workflow } from 'lucide-react';
import type { LibraryProfile, ProfileDetailView, ProfileLibraryView, ProfileRun } from '../../../../shared/types/profiles';
import { agentLabel } from '../../../../shared/agents';
import { API } from '../../utils/api';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { LaunchProfileDialog } from './LaunchProfileDialog';
import { ProfileFlow } from './ProfileFlow';

type ViewerTab = 'flow' | 'team' | 'yaml';

/** A profile's status as one short badge: invalid, team only, or on/off. */
function ProfileBadge({ profile }: { profile: LibraryProfile }) {
  const [label, tone] = !profile.valid
    ? ['invalid', 'border-status-error text-status-error']
    : profile.teamOnly
      ? ['team only', 'border-border-primary text-text-secondary']
      : profile.enabled
        ? ['on', 'border-status-success text-status-success']
        : ['off', 'border-border-primary text-text-tertiary'];
  return <span className={cn('rounded-full border px-1.5 text-[11px] leading-4', tone)} data-testid="profile-badge">{label}</span>;
}

function LibraryItem({ profile, selected, onSelect }: { profile: LibraryProfile; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      data-testid="profile-list-item"
      data-profile={profile.name}
      className={cn('flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left', selected ? 'bg-surface-selected' : 'hover:bg-surface-hover')}
    >
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">{profile.name}</span>
        <ProfileBadge profile={profile} />
      </span>
      <span className="truncate text-xs text-text-secondary">{profile.version ? `${profile.version} · ` : ''}{profile.title ?? (profile.valid ? `${profile.profile?.agents.length ?? 0} agents` : profile.errors[0]?.message)}</span>
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5">
      <h2 className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">{title}</h2>
      {children}
    </section>
  );
}

function TeamTab({ profile }: { profile: LibraryProfile }) {
  const agents = profile.profile?.agents ?? [];
  const steps = profile.profile?.flow?.steps ?? [];
  return (
    <div role="table" aria-label="Team" className="flex flex-col divide-y divide-border-primary rounded-lg border border-border-primary" data-testid="profile-team">
      {agents.map((agent) => (
        <div role="row" key={agent.id} className="grid gap-x-4 gap-y-1 px-3 py-2 [grid-template-columns:minmax(110px,160px)_1fr]" data-testid="profile-team-agent">
          <span role="cell" className="text-[13px] font-medium text-text-primary">{agent.id}</span>
          <span role="cell" className="flex flex-col gap-1 text-xs text-text-secondary">
            <span>{agentLabel(agent.cli)}{agent.model ? ` · ${agent.model}` : ''}{agent.effort ? ` · effort ${agent.effort}` : ''}</span>
            {steps.some((step) => step.kind === 'agent' && step.agent === agent.id) && <span>Steps: {steps.filter((step) => step.kind === 'agent' && step.agent === agent.id).map((step) => step.id).join(', ')}</span>}
            {agent.reads.length > 0 && <span>Reads: {agent.reads.join(', ')}</span>}
            {agent.skills.length > 0 && <span className="text-text-tertiary">Skills: {agent.skills.join(', ')}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function RunRow({ run, onChanged }: { run: ProfileRun; onChanged: () => void }) {
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState<string | null>(null);
  const live = run.state !== 'ended' && run.state !== 'failed';
  const act = async (work: () => Promise<{ success: boolean; error?: string }>) => {
    setError(null);
    const response = await work();
    if (!response.success) setError(response.error ?? 'That did not work.');
    onChanged();
  };
  return (
    <div className="flex flex-col gap-1 px-3 py-2" data-testid="profile-run-row">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-text-primary">{run.profile}</span>
        <span className="text-text-secondary">{run.state} at {run.step}</span>
        <span className="min-w-0 flex-1 truncate text-text-tertiary">{run.prompt}</span>
        {live && run.state === 'running' && (
          <>
            <input className="w-32 rounded border border-border-primary bg-surface-primary px-1.5 py-0.5 text-xs text-text-primary" placeholder="outcome" aria-label={`Set outcome for ${run.step}`} value={outcome} onChange={(event) => setOutcome(event.target.value)} />
            <Button size="sm" variant="secondary" disabled={!outcome.trim()} onClick={() => void act(() => API.profiles.setOutcome(run.id, outcome.trim()))}>Set outcome…</Button>
          </>
        )}
        {live && <Button size="sm" variant="secondary" onClick={() => void act(() => API.profiles.stop(run.id))}>Stop</Button>}
      </div>
      {(run.error || error) && <p className="text-xs text-status-error">{error ?? run.error}</p>}
      {run.attention && <p className="text-xs text-status-warning" data-testid="profile-run-attention">{run.attention}</p>}
    </div>
  );
}

/** The Profiles page: every profile (bundled, yours, your Agent Farm), one opened with its Flow, Team and YAML, and launched runs. */
export function ProfilesView() {
  const [library, setLibrary] = useState<ProfileLibraryView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProfileDetailView | null>(null);
  const [tab, setTab] = useState<ViewerTab>('flow');
  const [launching, setLaunching] = useState(false);
  const [runs, setRuns] = useState<ProfileRun[]>([]);

  const reload = useCallback(async () => {
    const [list, runList] = await Promise.all([API.profiles.list().catch(() => null), API.profiles.runs().catch(() => null)]);
    if (list?.success && list.data) setLibrary(list.data);
    else setLoadError(list?.error ?? 'Pane could not list profiles.');
    if (runList?.success && runList.data) setRuns(runList.data);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const profiles = useMemo(() => library?.profiles ?? [], [library]);
  // Opens on the first profile that is on and launchable (greenfield on a fresh install).
  const selected = profiles.find((profile) => profile.name === selectedName)
    ?? profiles.find((profile) => profile.enabled && profile.launchable)
    ?? profiles[0];
  // Below this width the list sits above the profile instead of beside it.
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !('ResizeObserver' in window)) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 720));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void API.profiles.get(selected.name).then((response) => { if (!cancelled && response.success && response.data) setDetail(response.data); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [selected]);

  const toggle = async (profile: LibraryProfile) => {
    const response = await API.profiles.setEnabled(profile.name, !profile.enabled);
    if (response.success && response.data) setLibrary(response.data);
  };

  const sections: Array<[string, LibraryProfile[]]> = [
    ['Bundled, on', profiles.filter((profile) => profile.origin === 'bundled' && profile.enabled)],
    ['Bundled, one click to add', profiles.filter((profile) => profile.origin === 'bundled' && !profile.enabled)],
    ['Yours', profiles.filter((profile) => profile.origin === 'yours')],
  ];

  return (
    <div ref={rootRef} className={cn('flex min-h-0 min-w-0 flex-1 bg-surface-primary', narrow ? 'flex-col overflow-y-auto' : '')} data-testid="profiles-view">
      <aside className={cn('flex flex-shrink-0 flex-col border-border-primary', narrow ? 'max-h-64 border-b' : 'w-72 border-r')}>
        <div className="flex h-14 flex-shrink-0 items-center px-4">
          <h1 className="text-lg font-semibold text-text-primary">Profiles</h1>
        </div>
        <nav aria-label="Profiles" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
          {library?.agentFarm && library.agentFarm.state !== 'ready' && (
            <p className={cn('mx-1 mb-2 rounded-md border px-2 py-1.5 text-xs', library.agentFarm.state === 'installing' ? 'border-border-primary text-text-secondary' : 'border-status-error text-status-error')} data-testid="profiles-agent-farm-status">
              {library.agentFarm.state === 'installing' ? `Setting up the bundled Agent Farm ${library.agentFarm.version ?? ''}…` : library.agentFarm.error}
            </p>
          )}
          {sections.map(([title, items]) => items.length > 0 && (
            <Section key={title} title={title}>
              {items.map((profile) => <LibraryItem key={`${profile.origin}-${profile.name}-${profile.file}`} profile={profile} selected={profile === selected} onSelect={() => { setSelectedName(profile.name); setTab('flow'); }} />)}
            </Section>
          ))}
          {/* Your own Agent Farm shows only when it lists something, or why it couldn't. */}
          {library?.ownAgentFarm && (library.ownAgentFarm.profiles.length > 0 || library.ownAgentFarm.error) && (
            <Section title="Your Agent Farm">
              {library.ownAgentFarm.error && <p className="px-3 text-xs text-status-error">{library.ownAgentFarm.error}</p>}
              {library.ownAgentFarm.profiles.map((own) => (
                <div key={own.name} className="flex flex-col px-3 py-1.5" data-testid="own-agent-farm-profile">
                  <span className="truncate text-[13px] text-text-primary">{own.name}</span>
                  <span className="truncate text-[11px] text-text-tertiary">{own.source}{own.harness ? ` · ${agentLabel(own.harness)}` : ''} · runs through your agent-farm (+ menu › Profile…)</span>
                </div>
              ))}
            </Section>
          )}
        </nav>
      </aside>
      <main className={cn('min-w-0 flex-1 px-6 py-4', narrow ? '' : 'min-h-0 overflow-y-auto')}>
        {loadError && !library && <p className="text-sm text-status-error">{loadError}</p>}
        {!selected && library && (
          <div className="mx-auto mt-24 flex max-w-sm flex-col items-center gap-3 text-center">
            <Workflow className="h-6 w-6 text-text-tertiary" aria-hidden="true" />
            <p className="text-sm font-medium text-text-primary">No profiles</p>
            <p className="text-xs text-text-secondary">Put a *.profile.yaml file in your Pane folder's profiles/ folder to add one.</p>
          </div>
        )}
        {selected && (
          <div className="flex flex-col gap-4" data-testid="profile-viewer" data-profile={selected.name}>
            <header className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold text-text-primary">{selected.name}</h2>
              {selected.version && <span className="rounded-full border border-border-primary px-2 text-xs text-text-secondary">{selected.version} · {selected.origin === 'bundled' ? 'bundled' : 'yours'}</span>}
              <ProfileBadge profile={selected} />
              <div role="tablist" aria-label="Profile" className="inline-flex overflow-hidden rounded-md border border-border-primary">
                {(['flow', 'team', 'yaml'] as const).map((id) => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} data-testid={`profile-tab-${id}`} onClick={() => setTab(id)} className={cn('px-3 py-1 text-xs', tab === id ? 'bg-surface-selected font-medium text-text-primary' : 'text-text-secondary hover:bg-surface-hover')}>
                    {id === 'flow' ? 'Flow' : id === 'team' ? 'Team' : 'YAML'}
                  </button>
                ))}
              </div>
              <span className="flex-1" />
              {selected.origin === 'bundled' && selected.valid && (
                <Button size="sm" variant="secondary" onClick={() => void toggle(selected)} data-testid="profile-toggle-enabled">{selected.enabled ? 'Turn off' : 'Add'}</Button>
              )}
              <Button size="sm" disabled={!selected.launchable} title={selected.launchable ? undefined : selected.teamOnly ? 'Team only: this profile has no workflow to launch.' : 'Fix this profile\'s errors to launch it.'} onClick={() => setLaunching(true)} data-testid="profile-launch">Launch…</Button>
            </header>
            {selected.title && <p className="text-sm text-text-secondary">{selected.title}</p>}
            {selected.errors.length > 0 && (
              <ul className="flex flex-col gap-1 rounded-lg border border-status-error p-3" data-testid="profile-errors">
                {selected.errors.map((problem, index) => (
                  <li key={index} className="text-xs text-text-secondary"><span className="font-mono text-status-error">{problem.code}</span> {problem.message} <span className="text-text-tertiary">{problem.fix}</span></li>
                ))}
              </ul>
            )}
            {tab === 'flow' && selected.profile && <ProfileFlow profile={selected.profile} />}
            {tab === 'team' && <TeamTab profile={selected} />}
            {tab === 'yaml' && <pre className="overflow-x-auto rounded-lg border border-border-primary bg-surface-secondary p-3 font-mono text-xs text-text-primary" data-testid="profile-yaml">{detail?.profile.name === selected.name ? detail.yaml : 'Loading…'}</pre>}
            {runs.length > 0 && (
              <section className="flex flex-col gap-1">
                <h3 className="text-sm font-medium text-text-primary">Runs</h3>
                <div className="divide-y divide-border-primary rounded-lg border border-border-primary">
                  {runs.map((run) => <RunRow key={run.id} run={run} onChanged={() => void reload()} />)}
                </div>
              </section>
            )}
          </div>
        )}
      </main>
      {launching && selected && <LaunchProfileDialog profile={selected} onClose={() => setLaunching(false)} onLaunched={() => { setLaunching(false); void reload(); }} />}
    </div>
  );
}
