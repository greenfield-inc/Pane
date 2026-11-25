import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, ExternalLink, KeyRound, Plus } from 'lucide-react';
import { cn } from '../../../utils/cn';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { SecretValueInput } from '../../ui/SecretValueInput';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/Select';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingsPage } from '../SettingRow';
import { settingDomId } from '../catalog';
import { formatDistanceToNow } from '../../../utils/timestampUtils';
import { useNow } from '../../notify/useNow';
import { leaseEndLabel } from '../../notify/notifyFormat';
import { formatDuration } from '../../loops/loopRunView';
import { LOCAL_MACHINE_ID } from '../../../../../shared/types/machineConnections';
import {
  leaseReferenceText,
  loginSiteOrigin,
  loginSitesProblem,
  paneSecretKey,
  paneSecretNameProblem,
  paneSecretProjectProblem,
  paneSecretReferenceProblem,
  SECRET_LEASE_DEFAULT_MS,
  type PaneLoginUse,
  type PaneSecretReferenceSummary,
  type PaneSecretsOverview,
  type PaneSecretSummary,
  type SecretLeaseMachine,
  type SecretLeaseOnMachine,
  type SecretLeaseStartRequest,
  type SecretLeaseStartResult,
} from '../../../../../shared/types/paneSecrets';

const DOCS_URL = 'https://github.com/greenfield-inc/Pane/blob/main/docs/PANE_SECRETS.md';
const HOUR = 60 * 60 * 1000;
const LEASE_LENGTHS: Array<{ ms: number; label: string }> = [
  { ms: HOUR, label: '1 hour' },
  { ms: 4 * HOUR, label: '4 hours' },
  { ms: 8 * HOUR, label: '8 hours' },
  { ms: 24 * HOUR, label: '24 hours' },
  { ms: 72 * HOUR, label: '3 days' },
  { ms: 168 * HOUR, label: '7 days' },
];

function lengthLabel(ms: number): string {
  return LEASE_LENGTHS.find((length) => length.ms === ms)?.label ?? formatDuration(ms);
}

type Outcome<T> = { ok: true; data: T | undefined } | { ok: false };
type Run = <T>(change: () => Promise<{ success: boolean; data?: T; error?: string }>, failure: string) => Promise<Outcome<T>>;

/** A masked value field with Save and Cancel. The typed value leaves state once it is sent. */
function ValueForm({ label, onSave, onCancel }: { label: string; onSave: (value: string) => Promise<boolean>; onCancel: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value) return;
    setBusy(true);
    const sent = value;
    setValue('');
    await onSave(sent);
    setBusy(false);
  };
  return (
    <form className="flex items-center gap-2" onSubmit={(event) => void submit(event)}>
      <div className="min-w-0 flex-1">
        <SecretValueInput
          autoFocus
          aria-label={label}
          placeholder="New value"
          value={value}
          onValueChange={setValue}
          className="w-full font-mono text-sm"
        />
      </div>
      <Button type="submit" size="sm" disabled={!value || busy}>Save</Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
    </form>
  );
}

function ConfirmBar({ label, text, action, onConfirm, onCancel }: { label: string; text: string; action: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-surface-secondary px-3 py-2 text-sm text-text-secondary" role="group" aria-label={label}>
      <span className="min-w-0 flex-1">{text}</span>
      <Button type="button" variant="danger" size="sm" onClick={onConfirm}>{action}</Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

interface ReadSites {
  sites: string[];
  problem: string | null;
}

/** Typed sites, separated by spaces, commas or lines, as the exact origins a login may be filled on. */
function readSites(typed: string): ReadSites {
  const parts = typed.split(/[\s,]+/).filter(Boolean);
  const bad = parts.find((part) => loginSiteOrigin(part) === null);
  if (bad) return { sites: [], problem: `"${bad}" can't be a login's site. Use an https address, such as https://bank.example.` };
  const sites = [...new Set(parts.flatMap((part) => loginSiteOrigin(part) ?? []))];
  return { sites, problem: sites.length === 0 ? null : loginSitesProblem(sites) };
}

/** Where a login may be filled, and the exact origins that means. Empty is allowed only where a plain secret is too. */
function SitesInput({ value, onChange, autoFocus, label }: { value: string; onChange: (value: string) => void; autoFocus?: boolean; label: string }) {
  const { sites, problem } = readSites(value);
  return (
    <Input
      aria-label={label}
      placeholder="Sign-in site, e.g. https://bank.example"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      error={problem ?? undefined}
      helperText={sites.length > 0 ? `A login. Agents can fill it on ${sites.join(', ')} and nowhere else, and no command gets it.` : 'Add a site to save a password or PIN as a login that agents fill in browser tabs.'}
      className="font-mono text-sm"
      autoFocus={autoFocus}
      fullWidth
    />
  );
}

function SitesForm({ address, sites, onSave, onCancel }: { address: string; sites: string[] | undefined; onSave: (sites: string[]) => Promise<boolean>; onCancel: () => void }) {
  const [value, setValue] = useState(sites?.join(' ') ?? '');
  const [busy, setBusy] = useState(false);
  const read = readSites(value);
  const ready = read.sites.length > 0 && !read.problem;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    const saved = await onSave(read.sites);
    setBusy(false);
    if (saved) onCancel();
  };
  return (
    <form className="mt-2 space-y-2" onSubmit={(event) => void submit(event)} aria-label={`Sites for ${address}`}>
      <SitesInput label={`Sign-in sites for ${address}`} value={value} onChange={setValue} autoFocus />
      {!sites && <p className="text-xs text-text-tertiary">Commands that use {address} now stop getting it.</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!ready || busy}>{sites ? 'Save sites' : 'Use as a login'}</Button>
      </div>
    </form>
  );
}

/** A login's sites and its latest use. */
function LoginLine({ sites, uses }: { sites: string[]; uses: PaneLoginUse[] }) {
  const last = uses[0];
  return (
    <div className="mt-1 space-y-0.5 text-xs text-text-tertiary" data-testid="pane-secret-login">
      <p className="break-all">Login for <span className="font-mono text-text-secondary">{sites.join(', ')}</span></p>
      {last
        ? uses.slice(0, 3).map((use) => (
          <p key={`${use.at}:${use.machine ?? ''}`} className="break-words">
            {use.agent} in {use.pane} filled it on <span className="font-mono">{use.site}</span>{use.machine ? ` on ${use.machine}` : ''} {formatDistanceToNow(use.at)}
          </p>
        ))
        : <p>No recent fills.</p>}
    </div>
  );
}

function usesOf(uses: readonly PaneLoginUse[], secret: { project: string; name: string }): PaneLoginUse[] {
  return uses.filter((use) => use.project === secret.project && use.name === secret.name);
}

function SecretRow({ secret, uses, moveVault, onSet, onSites, onDelete, onMove }: {
  secret: PaneSecretSummary;
  uses: PaneLoginUse[];
  moveVault: string | null;
  onSites: (sites: string[]) => Promise<boolean>;
  onSet: (value: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onMove: () => Promise<boolean>;
}) {
  const [mode, setMode] = useState<'idle' | 'replace' | 'sites' | 'confirm-delete' | 'moving'>('idle');
  const address = paneSecretKey(secret.project, secret.name);
  return (
    <div className="py-3" data-testid="pane-secret-row" data-secret={address}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-sm text-text-primary">{secret.name}</span>
        <span className="font-mono text-xs tracking-widest text-text-muted" aria-hidden="true">••••••••</span>
        <span className="min-w-0 flex-1 truncate text-xs text-text-tertiary">
          Set on {secret.machine} {formatDistanceToNow(secret.updatedAt)}
        </span>
        {(mode === 'idle' || mode === 'moving') && (
          <span className="flex shrink-0 gap-1">
            {/* A login from 1Password is added with its own reference, so a login has no Move. */}
            {!secret.sites && <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!moveVault || mode === 'moving'}
              loading={mode === 'moving'}
              className="min-w-[10.5rem]"
              title={moveVault ? `Writes the value into a new item in ${moveVault}, then reads it from there` : 'Pick a 1Password vault for moved secrets first'}
              onClick={() => {
                setMode('moving');
                void onMove().then(() => setMode('idle'));
              }}
            >
              Move to 1Password
            </Button>}
            <Button type="button" variant="ghost" size="sm" disabled={mode === 'moving'} onClick={() => setMode('sites')}>{secret.sites ? 'Edit sites' : 'Use as a login'}</Button>
            <Button type="button" variant="secondary" size="sm" disabled={mode === 'moving'} onClick={() => setMode('replace')}>Replace</Button>
            <Button type="button" variant="ghost" size="sm" disabled={mode === 'moving'} onClick={() => setMode('confirm-delete')}>Delete</Button>
          </span>
        )}
      </div>
      {secret.sites && <LoginLine sites={secret.sites} uses={uses} />}
      {mode === 'sites' && <SitesForm address={address} sites={secret.sites} onSave={onSites} onCancel={() => setMode('idle')} />}
      {mode === 'replace' && (
        <div className="mt-2">
          <ValueForm
            label={`New value for ${address}`}
            onSave={async (value) => {
              const saved = await onSet(value);
              if (saved) setMode('idle');
              return saved;
            }}
            onCancel={() => setMode('idle')}
          />
        </div>
      )}
      {mode === 'confirm-delete' && (
        <ConfirmBar
          label={`Delete ${address}`}
          text={`Delete ${address} from all your machines? Agents that use it stop getting it.`}
          action="Delete"
          onConfirm={() => void onDelete().then((deleted) => { if (!deleted) setMode('idle'); })}
          onCancel={() => setMode('idle')}
        />
      )}
    </div>
  );
}

/** A 1Password reference: its address, never a value, and whether this desktop holds a lease on it. */
function ReferenceRow({ reference, uses, leasedUntil, now, onSites, onDelete }: {
  reference: PaneSecretReferenceSummary;
  uses: PaneLoginUse[];
  onSites: (sites: string[]) => Promise<boolean>;
  leasedUntil: number | null;
  now: number;
  onDelete: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const address = paneSecretKey(reference.project, reference.name);
  return (
    <div className="py-3" data-testid="pane-secret-reference-row" data-secret={address}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-sm text-text-primary">{reference.name}</span>
        <span className="shrink-0 text-xs text-text-secondary">from 1Password</span>
        <span className="min-w-0 max-w-[18rem] truncate font-mono text-xs text-text-tertiary" title={reference.reference}>{reference.reference}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-text-tertiary" data-testid="pane-secret-lease-state">
          {leasedUntil ? `leased until ${leaseEndLabel(leasedUntil, now)}` : 'no lease'}
        </span>
        {!confirming && !editing && (
          <span className="flex shrink-0 gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>{reference.sites ? 'Edit sites' : 'Use as a login'}</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>Remove</Button>
          </span>
        )}
      </div>
      {reference.sites && <LoginLine sites={reference.sites} uses={uses} />}
      {editing && (
        <SitesForm address={address} sites={reference.sites} onSave={onSites} onCancel={() => setEditing(false)} />
      )}
      {editing && leasedUntil !== null && <p className="mt-1 text-xs text-text-tertiary">A new site works from the next lease; a removed one stops now.</p>}
      {confirming && (
        <ConfirmBar
          label={`Remove ${address}`}
          text={`Remove ${address} from all your machines? Agents that use it stop getting it. The 1Password item stays.`}
          action="Remove"
          onConfirm={() => void onDelete().then((removed) => { if (!removed) setConfirming(false); })}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function AddReferenceForm({ typed, onAdd, onCancel }: {
  typed: PaneSecretSummary[];
  onAdd: (project: string, name: string, reference: string, sites?: string[]) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [project, setProject] = useState('');
  const [name, setName] = useState('');
  const [reference, setReference] = useState('');
  const [sites, setSites] = useState('');
  const chosen = readSites(sites);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const projectProblem = project ? paneSecretProjectProblem(project.trim()) : null;
  const nameProblem = name ? paneSecretNameProblem(name.trim()) : null;
  const referenceProblem = reference ? paneSecretReferenceProblem(reference.trim()) : null;
  const ready = project.trim() && name.trim() && reference.trim() && !projectProblem && !nameProblem && !referenceProblem && !chosen.problem;
  const replacesTyped = typed.some((secret) => secret.project === project.trim() && secret.name === name.trim());
  const address = paneSecretKey(project.trim(), name.trim());
  const add = async () => {
    setBusy(true);
    let added = false;
    try {
      added = await onAdd(project.trim(), name.trim(), reference.trim(), chosen.sites.length > 0 ? chosen.sites : undefined);
    } finally {
      setBusy(false);
    }
    if (added) onCancel();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    if (replacesTyped && !confirming) setConfirming(true);
    else void add();
  };
  return (
    <form className="space-y-2 rounded-md border border-border-secondary p-3" onSubmit={submit} aria-label="Add from 1Password">
      <div className="flex flex-wrap gap-2">
        <div className="min-w-[10rem] flex-1">
          <Input aria-label="Reference project" placeholder="Project, e.g. stripe" value={project} onChange={(event) => { setProject(event.target.value); setConfirming(false); }} error={projectProblem ?? undefined} className="font-mono text-sm" autoFocus fullWidth />
        </div>
        <div className="min-w-[10rem] flex-1">
          <Input aria-label="Reference name" placeholder="NAME, e.g. STRIPE_SECRET_KEY" value={name} onChange={(event) => { setName(event.target.value); setConfirming(false); }} error={nameProblem ?? undefined} className="font-mono text-sm" fullWidth />
        </div>
      </div>
      <Input
        aria-label="1Password reference"
        placeholder="op://vault/item/field"
        value={reference}
        onChange={(event) => setReference(event.target.value)}
        error={referenceProblem ?? undefined}
        helperText={referenceProblem ? undefined : 'In 1Password, open the item and choose Copy Secret Reference on the field.'}
        className="font-mono text-sm"
        fullWidth
      />
      <SitesInput label="Reference sign-in site" value={sites} onChange={setSites} />
      {confirming ? (
        <ConfirmBar
          label={`Replace ${address}`}
          text={`${address} is a typed secret. Adding this reference deletes the typed value on every machine.`}
          action="Replace"
          onConfirm={() => void add()}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button type="submit" size="sm" disabled={!ready || busy}>Add reference</Button>
        </div>
      )}
    </form>
  );
}

function LeaseLengthSelect({ project, lengthMs, onChange }: { project: string; lengthMs: number; onChange: (ms: number) => void }) {
  const known = LEASE_LENGTHS.some((length) => length.ms === lengthMs);
  return (
    <Select value={String(lengthMs)} onValueChange={(value) => onChange(Number(value))}>
      <SelectTrigger aria-label={`Lease length for ${project}`} className="h-[30px] w-[120px]"><SelectValue /></SelectTrigger>
      <SelectContent>
        {!known && <SelectItem value={String(lengthMs)}>{lengthLabel(lengthMs)}</SelectItem>}
        {LEASE_LENGTHS.map((length) => (
          <SelectItem key={length.ms} value={String(length.ms)}>{length.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Check({ label, checked, disabled, onChange, note, address }: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  note?: string | null;
  /** The 1Password item this name reads from, so the person sees what they lease. */
  address?: string;
}) {
  return (
    <label className="flex items-start gap-2 text-sm text-text-primary">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-primary accent-interactive" />
      <span className={cn('min-w-0', disabled && 'text-text-muted')}>
        {label}
        {address && <span className="block break-all font-mono text-xs text-text-tertiary">{address}</span>}
        {note && <span className="block text-xs text-text-tertiary">{note}</span>}
      </span>
    </label>
  );
}

function toggled(set: ReadonlySet<string>, value: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** Start lease: the project's references and the machines to hold them, defaulting to all names on this desktop. */
function StartLeaseForm({ project, references, machines, lengthMs, now, onStart, onCancel }: {
  project: string;
  references: PaneSecretReferenceSummary[];
  machines: SecretLeaseMachine[];
  lengthMs: number;
  now: number;
  onStart: (request: SecretLeaseStartRequest) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [names, setNames] = useState(() => new Set(references.map((reference) => reference.name)));
  const [picked, setPicked] = useState(() => new Set(machines.some((machine) => machine.id === LOCAL_MACHINE_ID && !machine.refusal) ? [LOCAL_MACHINE_ID] : []));
  const [busy, setBusy] = useState(false);
  const shown = new Map(references.map((reference) => [reference.name, leaseReferenceText(reference.reference, reference.sites)]));
  const start = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    let ok = false;
    try {
      // Sent in the order shown, whatever order they were ticked in.
      ok = await onStart({
        project,
        names: references.flatMap((reference) => (names.has(reference.name) ? [reference.name] : [])),
        references: Object.fromEntries(shown),
        machines: machines.flatMap((machine) => (picked.has(machine.id) ? [machine.id] : [])),
      });
    } finally {
      setBusy(false);
    }
    if (ok) onCancel();
  };
  return (
    <form className="space-y-3 rounded-md border border-border-secondary p-3" onSubmit={(event) => void start(event)} aria-label={`Start lease for ${project}`}>
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-xs font-medium text-text-secondary">Secrets</legend>
        {references.map((reference) => (
          <Check key={reference.name} label={reference.name} address={shown.get(reference.name)} checked={names.has(reference.name)} onChange={(on) => setNames(toggled(names, reference.name, on))} />
        ))}
      </fieldset>
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-xs font-medium text-text-secondary">Machines</legend>
        {machines.map((machine) => (
          <Check
            key={machine.id}
            label={machine.name}
            checked={picked.has(machine.id)}
            disabled={Boolean(machine.refusal)}
            note={machine.refusal ?? (machine.memoryOnly ? 'Held in memory: ends if Pane restarts there.' : null)}
            onChange={(on) => setPicked(toggled(picked, machine.id, on))}
          />
        ))}
      </fieldset>
      <p className="text-xs text-text-tertiary">
        Lasts {lengthLabel(lengthMs)}, until {leaseEndLabel(now + lengthMs, now)}. 1Password asks once.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" className="min-w-[7.5rem]" loading={busy} disabled={busy || names.size === 0 || picked.size === 0}>Start lease</Button>
      </div>
    </form>
  );
}

/** "1Password vault for moved secrets": loads vault names on request, since listing them may prompt. */
function MoveVaultPicker({ moveVault, run }: { moveVault: string | null; run: Run }) {
  const [vaults, setVaults] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const outcome = await run(() => window.electronAPI.paneSecrets.listVaults(), 'Pane could not list your 1Password vaults.');
      if (outcome.ok) setVaults(outcome.data ?? []);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="pane-secrets-move-vault">
      <span className="text-text-secondary">1Password vault for moved secrets:</span>
      {/* The open picker shows the current vault itself. */}
      {!vaults && <span className="font-mono text-text-primary">{moveVault ?? 'none picked'}</span>}
      {vaults ? (
        <Select value={moveVault ?? undefined} onValueChange={(vault) => void run(() => window.electronAPI.paneSecrets.setMoveVault(vault), `Pane could not save ${vault} as the vault.`).then(() => setVaults(null))}>
          <SelectTrigger aria-label="1Password vault for moved secrets" className="h-[30px] w-[180px]"><SelectValue placeholder="Pick a vault" /></SelectTrigger>
          <SelectContent>
            {vaults.map((vault) => <SelectItem key={vault} value={vault}>{vault}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : (
        <Button type="button" variant="secondary" size="sm" className="min-w-[8.5rem]" loading={loading} disabled={loading} title="Reads your vault names from 1Password, which may ask you to approve." onClick={() => void load()}>
          {moveVault ? 'Change vault' : 'Choose vault'}
        </Button>
      )}
    </div>
  );
}

/** Active leases, one row per lease with every machine that holds it. */
function ActiveLeases({ leases, now, run }: { leases: SecretLeaseOnMachine[]; now: number; run: Run }) {
  const [confirmingAll, setConfirmingAll] = useState(false);
  const groups = new Map<string, SecretLeaseOnMachine[]>();
  for (const lease of leases) groups.set(lease.id, [...(groups.get(lease.id) ?? []), lease]);
  return (
    <SettingsSection title="Active leases" icon={<KeyRound className="h-4 w-4" />} spacing="sm">
      <div className="divide-y divide-border-secondary">
        {[...groups].map(([id, held]) => {
          const lease = held[0];
          const endsAt = Date.parse(lease.expiresAt);
          return (
            <div key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3" data-testid="pane-secret-lease" data-lease={id}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-text-primary">
                  <span className="font-medium">{lease.project}</span> <span className="font-mono">{lease.names.join(', ')}</span>
                </div>
                <div className="truncate text-xs text-text-tertiary">
                  On {held.map((copy) => copy.machine + (copy.memoryOnly ? ' (in memory)' : '')).join(', ')} · {formatDuration(Math.max(0, endsAt - now))} left, ends {leaseEndLabel(endsAt, now)} · asked by {lease.requestedBy}
                </div>
              </div>
              <Button type="button" variant="secondary" size="sm" onClick={() => void run(() => window.electronAPI.paneSecrets.endLease(id), 'Pane could not end the lease.')}>End now</Button>
            </div>
          );
        })}
      </div>
      {/* One child of the section, so its row dividers don't draw a short line over the button. */}
      <div className="space-y-2">
        {confirmingAll ? (
          <ConfirmBar
            label="End all leases"
            text="End every lease on all your machines? Agents stop getting these secrets until a new lease starts."
            action="End all"
            onConfirm={() => void run(() => window.electronAPI.paneSecrets.endAllLeases(), 'Pane could not end your leases.').then(() => setConfirmingAll(false))}
            onCancel={() => setConfirmingAll(false)}
          />
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingAll(true)}>End all</Button>
        )}
        <p className="text-xs text-text-tertiary">A command already running keeps the values it started with.</p>
      </div>
    </SettingsSection>
  );
}

function AddSecretForm({ onAdd, onCancel }: { onAdd: (project: string, name: string, value: string, sites?: string[]) => Promise<boolean>; onCancel: () => void }) {
  const [project, setProject] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [sites, setSites] = useState('');
  const chosen = readSites(sites);
  const [busy, setBusy] = useState(false);
  const projectProblem = project ? paneSecretProjectProblem(project.trim()) : null;
  const nameProblem = name ? paneSecretNameProblem(name.trim()) : null;
  const ready = project.trim() && name.trim() && value && !projectProblem && !nameProblem && !chosen.problem;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    const sent = value;
    setValue('');
    const added = await onAdd(project.trim(), name.trim(), sent, chosen.sites.length > 0 ? chosen.sites : undefined);
    setBusy(false);
    if (added) onCancel();
  };
  return (
    <form className="space-y-2 rounded-md border border-border-secondary p-3" onSubmit={(event) => void submit(event)} aria-label="Add a secret">
      <div className="flex flex-wrap gap-2">
        <div className="min-w-[10rem] flex-1">
          <Input aria-label="Secret project" placeholder="Project, e.g. stripe" value={project} onChange={(event) => setProject(event.target.value)} error={projectProblem ?? undefined} className="font-mono text-sm" autoFocus fullWidth />
        </div>
        <div className="min-w-[10rem] flex-1">
          <Input aria-label="Secret name" placeholder="NAME, e.g. STRIPE_SECRET_KEY" value={name} onChange={(event) => setName(event.target.value)} error={nameProblem ?? undefined} className="font-mono text-sm" fullWidth />
        </div>
      </div>
      <SecretValueInput aria-label="Secret value" placeholder="Value" value={value} onValueChange={setValue} className="font-mono text-sm" />
      <SitesInput label="Secret sign-in site" value={sites} onChange={setSites} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!ready || busy}>Save securely</Button>
      </div>
    </form>
  );
}

/** One project: its typed secrets and 1Password references, its lease length, and Start lease. */
function ProjectSection({ project, overview, now, run, set, setSites, remove }: {
  project: string;
  overview: PaneSecretsOverview;
  now: number;
  run: Run;
  set: (project: string, name: string, value: string) => Promise<boolean>;
  setSites: (project: string, name: string, sites: string[]) => Promise<boolean>;
  remove: (project: string, name: string) => Promise<boolean>;
}) {
  const [leasing, setLeasing] = useState(false);
  const [result, setResult] = useState<SecretLeaseStartResult | null>(null);
  const secrets = overview.secrets.filter((secret) => secret.project === project).sort(byName);
  const references = overview.references.filter((reference) => reference.project === project).sort(byName);
  const lengthMs = overview.leaseLengths[project] ?? SECRET_LEASE_DEFAULT_MS;
  const leasedUntil = (name: string): number | null => overview.leases.reduce<number | null>((latest, lease) => {
    if (lease.machineId !== LOCAL_MACHINE_ID || lease.project !== project || !lease.names.includes(name)) return latest;
    const ends = Date.parse(lease.expiresAt);
    return latest === null || ends > latest ? ends : latest;
  }, null);
  const start = async (request: SecretLeaseStartRequest) => {
    const outcome = await run(() => window.electronAPI.paneSecrets.startLease(request), `Pane could not start a lease for ${project}.`);
    if (outcome.ok) setResult(outcome.data ?? null);
    return outcome.ok;
  };
  return (
    <SettingsSection title={project} icon={<KeyRound className="h-4 w-4" />} spacing="sm">
      <div className="divide-y divide-border-secondary">
        {secrets.map((secret) => (
          <SecretRow
            key={`typed:${secret.name}`}
            secret={secret}
            uses={usesOf(overview.loginUses, secret)}
            moveVault={overview.moveVault}
            onSites={(sites) => setSites(project, secret.name, sites)}
            onSet={(value) => set(project, secret.name, value)}
            onDelete={() => remove(project, secret.name)}
            onMove={async () => (await run(() => window.electronAPI.paneSecrets.moveToOnePassword(project, secret.name), `Pane could not move ${paneSecretKey(project, secret.name)} to 1Password.`)).ok}
          />
        ))}
        {references.map((reference) => (
          <ReferenceRow
            key={`ref:${reference.name}`}
            reference={reference}
            uses={usesOf(overview.loginUses, reference)}
            onSites={(sites) => setSites(project, reference.name, sites)}
            leasedUntil={leasedUntil(reference.name)}
            now={now}
            onDelete={() => remove(project, reference.name)}
          />
        ))}
      </div>
      {references.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
            <span>Lease length</span>
            <LeaseLengthSelect
              project={project}
              lengthMs={lengthMs}
              onChange={(ms) => void run(() => window.electronAPI.paneSecrets.setLeaseLength(project, ms), `Pane could not save the lease length for ${project}.`)}
            />
            {!leasing && (
              <Button type="button" variant="secondary" size="sm" onClick={() => { setResult(null); setLeasing(true); }}>Start lease</Button>
            )}
          </div>
          {leasing && (
            <StartLeaseForm
              project={project}
              references={references}
              machines={overview.machines}
              lengthMs={lengthMs}
              now={now}
              onStart={start}
              onCancel={() => setLeasing(false)}
            />
          )}
          {result && (
            <div className="text-sm" data-testid="pane-secrets-lease-result">
              {result.machines.length > 0 && (
                <p className="text-text-secondary">Leased until {leaseEndLabel(Date.parse(result.expiresAt), now)} on {result.machines.join(', ')}.</p>
              )}
              {result.refused.map((refused) => (
                <p key={refused.machine} className="text-status-warning">Not sent to {refused.machine}: {refused.reason}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

/** Settings → Secrets: this computer's Pane secrets and 1Password leases. Values go in only; none is ever shown. */
export function SecretsSettings() {
  const [overview, setOverview] = useState<PaneSecretsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<'typed' | 'reference' | null>(null);
  const now = useNow();

  const refresh = useCallback(async () => {
    const response = await window.electronAPI.paneSecrets.list().catch((err: Error) => ({ success: false as const, error: err.message, data: undefined }));
    if (response.success && response.data) {
      setOverview(response.data);
    } else {
      setError(response.error || 'Pane could not list your secrets.');
    }
  }, []);
  useEffect(() => {
    void refresh();
    return window.electronAPI.paneSecrets.onChanged(() => void refresh());
  }, [refresh]);

  /** Runs one change, shows its error as main wrote it, and reloads the list. */
  const run: Run = async (change, failure) => {
    setError(null);
    const response = await change().catch((err: Error) => ({ success: false, error: err.message, data: undefined }));
    if (!response.success) setError(response.error || failure);
    await refresh();
    return response.success ? { ok: true, data: response.data } : { ok: false };
  };
  const set = async (project: string, name: string, value: string, sites?: string[]) =>
    (await run(() => window.electronAPI.paneSecrets.set(project, name, value, sites), `Pane could not save ${paneSecretKey(project, name)}.`)).ok;
  const remove = async (project: string, name: string) =>
    (await run(() => window.electronAPI.paneSecrets.delete(project, name), `Pane could not delete ${paneSecretKey(project, name)}.`)).ok;
  const setSites = async (project: string, name: string, sites: string[]) =>
    (await run(() => window.electronAPI.paneSecrets.setSites(project, name, sites), `Pane could not save the sites for ${paneSecretKey(project, name)}.`)).ok;
  const setReference = async (project: string, name: string, reference: string, sites?: string[]) =>
    (await run(() => window.electronAPI.paneSecrets.setReference(project, name, reference, sites), `Pane could not add ${paneSecretKey(project, name)}.`)).ok;

  const projects = [...new Set([...(overview?.secrets ?? []), ...(overview?.references ?? [])].map((secret) => secret.project))].sort((a, b) => a.localeCompare(b));

  return (
    <SettingsPage title="Secrets" description="Values your agents asked for or you added, synced to every machine you saved in Pane.">
      <div id={settingDomId('pane-secrets')} data-setting-id="pane-secrets" tabIndex={-1} className="space-y-6 outline-none">
        <div className="space-y-2">
          <p className="text-sm text-text-secondary">
            Any agent on your machines can use these with <code className="font-mono text-text-primary">runpane secrets exec</code>. Values are never shown again.
            A login is the exception: agents can only fill it in a browser tab, on the sites you choose.
            A 1Password secret has a value only while a lease you start is active.{' '}
            <button type="button" className="inline-flex items-center gap-1 text-interactive hover:underline" onClick={() => void window.electronAPI.openExternal(DOCS_URL)}>
              How secrets work <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </button>
          </p>
          {overview && !overview.storage.encrypted && (
            <p className="flex items-center gap-1.5 text-sm text-status-warning" data-testid="pane-secrets-unencrypted">
              <AlertTriangle className="h-4 w-4 shrink-0" /> Stored unencrypted on this host (no OS keyring).
            </p>
          )}
          {error && <p className="text-sm text-status-error" role="alert">{error}</p>}
        </div>

        {adding === 'typed' && <AddSecretForm onAdd={set} onCancel={() => setAdding(null)} />}
        {adding === 'reference' && <AddReferenceForm typed={overview?.secrets ?? []} onAdd={setReference} onCancel={() => setAdding(null)} />}
        {!adding && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding('typed')}>
              Add secret
            </Button>
            <Button type="button" variant="secondary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding('reference')}>
              Add from 1Password
            </Button>
          </div>
        )}
        {overview && <MoveVaultPicker moveVault={overview.moveVault} run={run} />}

        {overview && projects.length === 0 && (
          <p className="text-sm text-text-tertiary">No secrets yet. When an agent asks you for one, or you add one, it shows here.</p>
        )}
        {overview && projects.map((project) => (
          <ProjectSection key={project} project={project} overview={overview} now={now} run={run} set={set} setSites={setSites} remove={remove} />
        ))}
        {overview && overview.leases.length > 0 && <ActiveLeases leases={overview.leases} now={now} run={run} />}
      </div>
    </SettingsPage>
  );
}
