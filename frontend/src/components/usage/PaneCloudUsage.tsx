import { useEffect, type ReactNode } from 'react';
import { ExternalLink, LogIn } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { RemoteGroup } from '../settings/RemoteGroup';
import { usePaneCloudStore } from '../../stores/paneCloudStore';
import type { PaneCloudSnapshot, PaneCloudUsage as Usage } from '../../../../shared/types/paneCloud';

const PLAN_NAMES = { free: 'Free', pro: 'Pro', max: 'Max' } as const;

/** "December 1", the day the month's hours reset (UTC). */
function resetDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** "November 2026", the month the hours count, from the reset date. */
function usageMonth(resetsAt: string): string {
  const reset = new Date(resetsAt);
  return new Date(Date.UTC(reset.getUTCFullYear(), reset.getUTCMonth() - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Whole agent-hours, as the usage rows show them: a plain number, never a bar. */
function hours(value: number): string {
  return Math.floor(value).toLocaleString();
}

function Row({ label, description, children }: { label: string; description?: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        {description && <p className="mt-0.5 text-xs text-text-tertiary">{description}</p>}
      </div>
      <div className="flex flex-none items-center gap-2 text-sm tabular-nums text-text-primary">{children}</div>
    </div>
  );
}

/**
 * Pane Cloud in Usage & Limits: the plan, agent-hours as a plain number of the month's amount with
 * the reset date, Sessions awake of the limit, Sessions kept, the 16 GB line once, and hours by
 * member. Signing in to Pane Cloud starts here too.
 */
export function PaneCloudUsage() {
  const snapshot = usePaneCloudStore((state) => state.snapshot);
  const loaded = usePaneCloudStore((state) => state.loaded);
  useEffect(() => usePaneCloudStore.getState().follow(), []);
  if (!loaded) return null;
  return (
    <div className="mx-auto mb-6 flex max-w-3xl flex-col gap-6" data-testid="pane-cloud-usage">
      {snapshot.error && (
        <div className="rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-text-primary" role="alert">
          <p>{snapshot.error.message}</p>
          {snapshot.error.next && <p className="mt-1 text-text-secondary">{snapshot.error.next}</p>}
        </div>
      )}
      {snapshot.signIn.state === 'signed-in' && snapshot.usage
        ? <SignedInUsage snapshot={snapshot} usage={snapshot.usage} />
        : <SignInGroup snapshot={snapshot} />}
    </div>
  );
}

function SignInGroup({ snapshot }: { snapshot: PaneCloudSnapshot }) {
  const { signIn } = snapshot;
  const { signIn: startSignIn, signOut } = usePaneCloudStore.getState();
  return (
    <RemoteGroup title="Pane Cloud" aside={<Badge size="sm">Beta</Badge>}>
      {signIn.state === 'unavailable' ? (
        <Row label="Pane Cloud" description="Pane can't reach Pane Cloud right now, so your plan and hours can't be shown. Your cloud Sessions keep running.">
          <Button type="button" size="sm" variant="ghost" onClick={() => void usePaneCloudStore.getState().refresh()}>Try again</Button>
        </Row>
      ) : signIn.state === 'pending' ? (
        <Row label="Finish signing in in your browser" description={`Your code is ${signIn.userCode}. Pane waits here until you finish.`}>
          <Button type="button" size="sm" variant="ghost" onClick={() => void signOut()}>Cancel</Button>
        </Row>
      ) : signIn.state === 'signed-in' && signIn.access === 'waitlisted' ? (
        <Row label="You're on the list" description="Pane Cloud is invite-only for now. Your invite arrives by email.">
          <Button type="button" size="sm" variant="ghost" onClick={() => void signOut()}>Sign out</Button>
        </Row>
      ) : (
        <Row label="Pane Cloud" description="A machine for each Session that keeps working when this computer is closed. 300 agent-hours a month free. Most people never reach this.">
          <Button type="button" size="sm" icon={<LogIn className="h-4 w-4" />} onClick={() => void startSignIn()}>Sign in</Button>
        </Row>
      )}
    </RemoteGroup>
  );
}

function SignedInUsage({ snapshot, usage }: { snapshot: PaneCloudSnapshot; usage: Usage }) {
  const { signIn, sessions } = snapshot;
  if (signIn.state !== 'signed-in') return null;
  const plan = PLAN_NAMES[usage.plan];
  const shared = usage.members.length > 1;
  return (
    <>
      <RemoteGroup
        title="Pane Cloud"
        scope={usageMonth(usage.resetsAt)}
        aside={<Badge size="sm">Beta</Badge>}
        footnote="An hour in a Session running at 16 GB counts as 2 hours."
      >
        <Row label="Plan" description={`${plan} · ${usage.planAgentHours.toLocaleString()} agent-hours a month, ${usage.planAwakeLimit} Sessions awake at once.`} />
        <Row
          label="Agent-hours"
          description={`${shared ? 'Shared by everyone in your organization. ' : ''}The month starts again on ${resetDay(usage.resetsAt)}.`}
        >
          {usage.agentHoursLimit === null ? hours(usage.agentHoursUsed) : `${hours(usage.agentHoursUsed)} of ${usage.agentHoursLimit.toLocaleString()}`}
        </Row>
        <Row label="Your Sessions awake now" description={`You can have ${usage.awakeLimit} awake at once.`}>
          {`${usage.awakeNow} of ${usage.awakeLimit}`}
        </Row>
        <Row label="Sessions kept" description="Cloud Sessions with saved chats and files.">
          {sessions.length}
        </Row>
        {signupStep(signIn) && (
          <Row label="Finish signing up" description={signupStep(signIn) ?? undefined}>
            <Button type="button" size="sm" icon={<ExternalLink className="h-4 w-4" />} onClick={() => void window.electronAPI?.openExternal(signIn.signupUrl)}>Open sign-up</Button>
          </Row>
        )}
        <Row label="Account" description={`Signed in as ${signIn.email}.`}>
          <Button type="button" size="sm" variant="ghost" onClick={() => void usePaneCloudStore.getState().signOut()}>Sign out</Button>
        </Row>
      </RemoteGroup>
      {shared && (
        <RemoteGroup title="By member">
          {usage.members.map((member) => (
            <div key={member.accountId} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
              <span className="flex min-w-0 items-center gap-2 text-text-primary">
                <span className="truncate">{member.name ?? 'Member'}</span>
                {member.you && <Badge size="sm">You</Badge>}
              </span>
              <span className="flex flex-none items-center gap-8 tabular-nums">
                <span className="text-text-primary">{hours(member.agentHours)} h</span>
                <span className="w-24 text-right text-text-tertiary">{member.awakeLimit > 0 ? `${member.awakeNow} of ${member.awakeLimit} awake` : 'View only'}</span>
              </span>
            </div>
          ))}
        </RemoteGroup>
      )}
    </>
  );
}

function signupStep(signIn: Extract<PaneCloudSnapshot['signIn'], { state: 'signed-in' }>): string | null {
  if (signIn.signupState === 'needs_phone') return 'Verify your mobile number to create cloud Sessions.';
  if (signIn.signupState === 'needs_card') return 'Add a card ($0 check) to create cloud Sessions.';
  return null;
}
