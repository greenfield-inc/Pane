import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Github } from 'lucide-react';
import { LOOP_DEFAULT_COMMENT_PHRASE, LOOP_DEFAULT_HOURLY_CAP, LOOP_NAME_MAX_LENGTH, LOOP_NEW_SESSION, type Loop, type LoopAgent, type LoopGithubTriggers, type LoopInput, type LoopSchedulePreview } from '../../../../shared/types/loop';
import { useLoopsStore } from '../../stores/loopsStore';
import { isArchivedOrchestrationSession, useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { API } from '../../utils/api';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { Textarea } from '../ui/Textarea';
import { SegmentedControl } from '../settings/SettingsControls';
import { formatRunTime } from './loopRunView';
import { WEEKDAYS, cronFromSchedule, describeSchedule, repeatLabel, scheduleFromCron, type LoopRepeat, type LoopSchedule } from '../../../../shared/utils/loopSchedule';
import { useProjectList } from './useProjectList';

type Runner = LoopAgent | 'command';
type Target = 'project' | 'session';
type Starts = 'schedule' | 'github' | 'both';

const STARTS = [
  { id: 'schedule', label: 'Schedule' },
  { id: 'github', label: 'GitHub events' },
  { id: 'both', label: 'Both' },
] as const satisfies ReadonlyArray<{ id: Starts; label: string }>;

/** The GitHub trigger fields as the form edits them; switched-off fields keep their text. */
interface GithubForm {
  repo: string;
  onComment: boolean;
  commentPhrase: string;
  changesRequested: boolean;
  checkFailed: boolean;
  prOpened: boolean;
  onLabel: boolean;
  issueLabel: string;
  allowForks: boolean;
  hourlyCap: number;
}

function githubFormFrom(github: LoopGithubTriggers | undefined): GithubForm {
  return {
    repo: github?.repo ?? '',
    onComment: github ? Boolean(github.commentPhrase) : true,
    commentPhrase: github?.commentPhrase ?? LOOP_DEFAULT_COMMENT_PHRASE,
    changesRequested: github ? Boolean(github.changesRequested) : true,
    checkFailed: github ? Boolean(github.checkFailed) : true,
    prOpened: Boolean(github?.prOpened),
    onLabel: Boolean(github?.issueLabel),
    issueLabel: github?.issueLabel ?? 'agent',
    allowForks: Boolean(github?.allowForks),
    hourlyCap: github?.hourlyCap ?? LOOP_DEFAULT_HOURLY_CAP,
  };
}

function githubTriggers(form: GithubForm): LoopGithubTriggers {
  const triggers: LoopGithubTriggers = { repo: form.repo.trim() };
  if (form.onComment && form.commentPhrase.trim()) triggers.commentPhrase = form.commentPhrase.trim();
  if (form.changesRequested) triggers.changesRequested = true;
  if (form.checkFailed) triggers.checkFailed = true;
  if (form.prOpened) triggers.prOpened = true;
  if (form.onLabel && form.issueLabel.trim()) triggers.issueLabel = form.issueLabel.trim();
  if (form.allowForks) triggers.allowForks = true;
  if (form.hourlyCap !== LOOP_DEFAULT_HOURLY_CAP) triggers.hourlyCap = form.hourlyCap;
  return triggers;
}

/** A checkbox row in the form's own type scale. */
function CheckRow({ checked, onChange, label, children }: { checked: boolean; onChange: (checked: boolean) => void; label: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2.5">
      <label className="flex cursor-default items-center gap-2.5 text-sm text-text-primary">
        <input
          type="checkbox"
          checked={checked}
          onChange={event => onChange(event.target.checked)}
          className="rounded border-border-primary text-interactive focus:ring-interactive"
        />
        {label}
      </label>
      {children}
    </div>
  );
}

const TARGETS = [
  { id: 'project', label: 'Project' },
  { id: 'session', label: 'Session' },
] as const satisfies ReadonlyArray<{ id: Target; label: string }>;

const RUNNERS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'command', label: 'Command' },
] as const satisfies ReadonlyArray<{ id: Runner; label: string }>;
/** A Session loop messages the Session's agent, so it has no command. */
const SESSION_RUNNERS = RUNNERS.filter(runner => runner.id !== 'command');

const REPEATS: readonly LoopRepeat[] = ['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom'];

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, index) => String(index + 1));

const PREVIEW_DEBOUNCE_MS = 250;

interface LoopForm {
  name: string;
  target: Target;
  projectId: number | null;
  /** A Session id, or `LOOP_NEW_SESSION`. */
  sessionTarget: string;
  runner: Runner;
  toolCommand: string;
  initialInput: string;
  schedule: LoopSchedule;
  starts: Starts;
  github: GithubForm;
}

function formFrom(loop: Loop | undefined): LoopForm {
  return {
    name: loop?.name ?? '',
    target: loop?.orchestrationSessionId ? 'session' : 'project',
    projectId: loop?.projectId ?? null,
    sessionTarget: loop?.orchestrationSessionId ?? LOOP_NEW_SESSION,
    runner: loop?.toolCommand ? 'command' : loop?.agent ?? 'claude',
    toolCommand: loop?.toolCommand ?? '',
    initialInput: loop?.initialInput ?? '',
    schedule: scheduleFromCron(loop?.cron || '0 3 * * *'),
    starts: loop?.github ? (loop.cron ? 'both' : 'github') : 'schedule',
    github: githubFormFrom(loop?.github),
  };
}

/** The cron's meaning from main, asked again a moment after typing stops. */
function useSchedulePreview(cron: string): LoopSchedulePreview | null {
  const [preview, setPreview] = useState<LoopSchedulePreview | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const response = await API.loops.preview(cron.trim()).catch(() => null);
      if (cancelled) return;
      if (response?.success && response.data) setPreview(response.data);
      else setPreview({ ok: false, error: response?.error ?? 'Could not read this schedule.' });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cron]);
  return preview;
}

function LoopDrawerForm({ loop, onClose }: { loop: Loop | undefined; onClose: () => void }) {
  const save = useLoopsStore(state => state.save);
  const remove = useLoopsStore(state => state.remove);
  const projects = useProjectList();
  const allSessions = useOrchestrationSessionStore(state => state.sessions);
  // Loops run Claude, Codex or Cursor, so OpenCode Sessions are not offered.
  const sessions = useMemo(() => allSessions.filter(session => !isArchivedOrchestrationSession(session) && session.agent !== 'opencode'), [allSessions]);
  const loadSessions = useOrchestrationSessionStore(state => state.load);
  useEffect(() => { void loadSessions().catch(() => undefined); }, [loadSessions]);
  const [form, setForm] = useState<LoopForm>(() => formFrom(loop));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const cron = cronFromSchedule(form.schedule);
  const preview = useSchedulePreview(cron);
  const update = (fields: Partial<LoopForm>) => setForm(current => ({ ...current, ...fields }));
  const updateSchedule = (fields: Partial<LoopSchedule>) => setForm(current => ({ ...current, schedule: { ...current.schedule, ...fields } }));
  const updateGithub = (fields: Partial<GithubForm>) => setForm(current => ({ ...current, github: { ...current.github, ...fields } }));
  const { schedule, github } = form;
  const summary = describeSchedule(schedule);
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;

  // A new loop starts in the first project once the list arrives.
  const projectId = form.projectId ?? projects[0]?.id ?? null;
  const onSession = form.target === 'session';
  // GitHub events start runs in a project; a Session loop runs on its schedule.
  const starts: Starts = onSession ? 'schedule' : form.starts;
  const onSchedule = starts !== 'github';
  const onGithub = starts !== 'schedule';
  const triggers = githubTriggers(github);
  const missing = useMemo(() => {
    if (!form.name.trim()) return 'Add a name.';
    if (onSession) return form.initialInput.trim() ? null : 'Add the message to send each run.';
    if (projectId === null) return 'Choose a project.';
    if (form.runner === 'command' && !form.toolCommand.trim()) return 'Add the command to run.';
    if (onGithub && !triggers.commentPhrase && !triggers.changesRequested && !triggers.checkFailed && !triggers.prOpened && !triggers.issueLabel) {
      return 'Choose at least one GitHub event.';
    }
    return null;
  }, [form.name, form.initialInput, form.runner, form.toolCommand, onSession, projectId, onGithub, triggers.commentPhrase, triggers.changesRequested, triggers.checkFailed, triggers.prOpened, triggers.issueLabel]);
  const canSave = !busy && !missing && (!onSchedule || preview?.ok === true);

  const chooseTarget = (target: Target) => update(target === 'session' && form.runner === 'command' ? { target, runner: 'claude' } : { target });
  // An existing Session keeps its own agent unless the person picks another.
  const chooseSession = (sessionTarget: string) => {
    const agent = sessions.find(session => session.id === sessionTarget)?.agent;
    const runner = SESSION_RUNNERS.find(candidate => candidate.id === agent)?.id;
    update(runner ? { sessionTarget, runner } : { sessionTarget });
  };

  const handleSave = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const input: LoopInput = {
      name: form.name.trim(),
      cron: onSchedule ? cron : '',
      // Editing keeps the loop paused or running as it was; a new loop starts on.
      enabled: loop?.enabled ?? true,
    };
    if (loop) input.id = loop.id;
    if (onSession) input.orchestrationSessionId = form.sessionTarget;
    else if (projectId !== null) input.projectId = projectId;
    if (form.runner === 'command' && !onSession) input.toolCommand = form.toolCommand.trim();
    else input.agent = form.runner === 'command' ? 'claude' : form.runner;
    if (form.initialInput.trim()) input.initialInput = form.initialInput.trim();
    if (onGithub) input.github = triggers;
    // The branch template is set from the CLI or MCP only; saving keeps it.
    if (loop?.worktreeTemplate && !onSession) input.worktreeTemplate = loop.worktreeTemplate;
    const failure = await save(input);
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  };

  const handleDelete = async () => {
    if (!loop) return;
    setBusy(true);
    const failure = await remove(loop.id);
    setBusy(false);
    if (failure) {
      setError(failure);
      setConfirmingDelete(false);
    } else onClose();
  };

  return (
    <>
      <ModalHeader title={loop ? 'Edit loop' : 'New loop'} description={loop?.name} onClose={onClose} />
      <ModalBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p className="text-label font-medium text-text-primary">Runs in</p>
          <SegmentedControl label="Runs in" value={form.target} options={TARGETS} onChange={chooseTarget} />
        </div>

        <Input label="Name" value={form.name} onChange={event => update({ name: event.target.value })} placeholder="Nightly bug sweep" maxLength={LOOP_NAME_MAX_LENGTH} fullWidth autoFocus />

        {onSession ? (
          <div className="flex flex-col gap-2">
            <p className="text-label font-medium text-text-primary" id="loop-session-label">Session</p>
            <Select value={form.sessionTarget} onValueChange={chooseSession}>
              <SelectTrigger aria-labelledby="loop-session-label"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={LOOP_NEW_SESSION}>New Session for this loop</SelectItem>
                {sessions.map(session => <SelectItem key={session.id} value={session.id}>{session.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <div role="note" className="flex gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-text-primary">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-status-warning" aria-hidden="true" />
              <span>
                {form.sessionTarget === LOOP_NEW_SESSION
                  ? 'The new Session\'s agent will skip permission prompts for every message it gets, not only loop runs.'
                  : 'This Session\'s agent will skip permission prompts for every message it gets, not only loop runs. If it is running now, runs wait until you restart it; Pane never restarts it for you.'}
              </span>
            </div>
          </div>
        ) : (
          <div>
            <p className="mb-1 text-label font-medium text-text-primary" id="loop-project-label">Project</p>
            <Select value={projectId === null ? '' : String(projectId)} onValueChange={value => update({ projectId: Number(value) })}>
              <SelectTrigger aria-labelledby="loop-project-label"><SelectValue placeholder="Choose a project" /></SelectTrigger>
              <SelectContent>
                {projects.map(project => <SelectItem key={project.id} value={String(project.id)}>{project.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <p className="text-label font-medium text-text-primary">Runs</p>
          {onSession ? (
            <SegmentedControl label="Runs" value={form.runner} options={SESSION_RUNNERS} columns={3} onChange={runner => update({ runner })} />
          ) : (
            <SegmentedControl label="Runs" value={form.runner} options={RUNNERS} columns={4} onChange={runner => update({ runner })} />
          )}
          {form.runner === 'command' && !onSession && (
            <Input
              aria-label="Command"
              value={form.toolCommand}
              onChange={event => update({ toolCommand: event.target.value })}
              placeholder="./scripts/nightly-report.sh"
              className="font-mono text-sm"
              fullWidth
            />
          )}
          <Textarea
            aria-label={onSession ? 'Message' : 'First input'}
            value={form.initialInput}
            onChange={event => update({ initialInput: event.target.value })}
            placeholder={onSession ? 'Message sent to the Session\'s agent each run'
              : form.runner === 'command' ? 'Text typed into the command after it starts (optional)' : 'What the agent should do each run'}
            rows={3}
            className="text-sm"
          />
        </div>

        {!onSession && (
          <div className="flex flex-col gap-2">
            <p className="text-label font-medium text-text-primary">Starts on</p>
            <SegmentedControl label="Starts on" value={starts} options={STARTS} columns={3} onChange={value => update({ starts: value })} />
          </div>
        )}

        {onGithub && (
          <div className="flex flex-col gap-1 rounded-md border border-border-secondary px-3 py-2.5" data-testid="loop-github-triggers">
            <div className="mb-1 flex items-center gap-2">
              <Github className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
              <Input
                aria-label="GitHub repository"
                value={github.repo}
                onChange={event => updateGithub({ repo: event.target.value })}
                placeholder="owner/name (empty: the project's origin)"
                className="font-mono text-sm"
                spellCheck={false}
                fullWidth
              />
            </div>
            <CheckRow checked={github.onComment} onChange={onComment => updateGithub({ onComment })} label="PR comment or review containing">
              <Input
                aria-label="Comment phrase"
                value={github.commentPhrase}
                onChange={event => updateGithub({ commentPhrase: event.target.value })}
                disabled={!github.onComment}
                className="h-7 w-24 font-mono text-sm"
                spellCheck={false}
              />
            </CheckRow>
            <CheckRow checked={github.changesRequested} onChange={changesRequested => updateGithub({ changesRequested })} label="Review requesting changes" />
            <CheckRow checked={github.checkFailed} onChange={checkFailed => updateGithub({ checkFailed })} label="Failing check on a PR" />
            <CheckRow checked={github.prOpened} onChange={prOpened => updateGithub({ prOpened })} label="New PR" />
            <CheckRow checked={github.onLabel} onChange={onLabel => updateGithub({ onLabel })} label="Issue labeled">
              <Input
                aria-label="Issue label"
                value={github.issueLabel}
                onChange={event => updateGithub({ issueLabel: event.target.value })}
                disabled={!github.onLabel}
                className="h-7 w-24 font-mono text-sm"
                spellCheck={false}
              />
            </CheckRow>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-secondary pt-2">
              <CheckRow checked={github.allowForks} onChange={allowForks => updateGithub({ allowForks })} label="PRs from forks" />
              <label className="flex items-center gap-2 text-sm text-text-primary">
                At most
                <Input
                  aria-label="Hourly cap"
                  type="number"
                  min={1}
                  max={60}
                  value={github.hourlyCap}
                  onChange={event => {
                    const hourlyCap = event.target.valueAsNumber;
                    if (Number.isInteger(hourlyCap) && hourlyCap >= 1 && hourlyCap <= 60) updateGithub({ hourlyCap });
                  }}
                  className="h-7 w-16 text-sm"
                />
                runs an hour
              </label>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-text-tertiary">
              Comments and reviews count only from the repo's collaborators, and their text reaches the agent quoted as untrusted. This computer checks GitHub every 15 seconds with your gh sign-in while Pane is awake; events from while it slept are listed as missed, with Run now. An always-on host (Pane Cloud, BYOC or a Remote Pane machine) gets events around the clock.
            </p>
          </div>
        )}

        {onSchedule && <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-[4rem_1fr] items-center gap-x-3 gap-y-2">
            <p className="text-label font-medium text-text-primary" id="loop-repeat-label">Repeat</p>
            <Select
              value={schedule.repeat}
              onValueChange={value => {
                const repeat = REPEATS.find(candidate => candidate === value);
                if (!repeat) return;
                // Custom cron starts from the schedule the picker showed.
                updateSchedule(repeat === 'custom' ? { repeat, cron } : { repeat });
              }}
            >
              <SelectTrigger aria-labelledby="loop-repeat-label"><SelectValue /></SelectTrigger>
              <SelectContent>
                {REPEATS.map(repeat => <SelectItem key={repeat} value={repeat}>{repeatLabel(repeat, schedule)}</SelectItem>)}
              </SelectContent>
            </Select>

            {schedule.repeat === 'weekly' && (
              <>
                <p className="text-label font-medium text-text-primary" id="loop-weekdays-label">On</p>
                <div role="group" aria-labelledby="loop-weekdays-label" className="flex gap-1">
                  {WEEKDAYS.map(({ day, short, name }) => {
                    const on = schedule.weekdays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-label={name}
                        aria-pressed={on}
                        title={name}
                        // A weekly loop keeps at least one day.
                        onClick={() => {
                          if (on && schedule.weekdays.length === 1) return;
                          const weekdays = on ? schedule.weekdays.filter(other => other !== day) : [...schedule.weekdays, day];
                          updateSchedule({ weekdays: weekdays.sort((a, b) => a - b) });
                        }}
                        className={cn(
                          'h-8 w-8 rounded-full text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle',
                          on ? 'bg-interactive text-text-on-interactive' : 'bg-surface-secondary text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                        )}
                      >
                        {short[0]}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {schedule.repeat === 'monthly' && (
              <>
                <p className="text-label font-medium text-text-primary" id="loop-day-label">On day</p>
                <Select value={String(schedule.dayOfMonth)} onValueChange={value => updateSchedule({ dayOfMonth: Number(value) })}>
                  <SelectTrigger aria-labelledby="loop-day-label" className="w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DAYS_OF_MONTH.map(day => <SelectItem key={day} value={day}>{day}</SelectItem>)}
                  </SelectContent>
                </Select>
              </>
            )}

            {schedule.repeat === 'hourly' && (
              <>
                <label className="text-label font-medium text-text-primary" htmlFor="loop-minute">At</label>
                <div className="flex items-center gap-2 text-sm text-text-secondary">
                  <Input
                    id="loop-minute"
                    type="number"
                    min={0}
                    max={59}
                    value={schedule.minute}
                    onChange={event => {
                      const minute = event.target.valueAsNumber;
                      if (Number.isInteger(minute) && minute >= 0 && minute <= 59) updateSchedule({ minute });
                    }}
                    className="w-20 text-sm"
                  />
                  minutes past each hour
                </div>
              </>
            )}

            {schedule.repeat !== 'hourly' && schedule.repeat !== 'custom' && (
              <>
                <label className="text-label font-medium text-text-primary" htmlFor="loop-time">At</label>
                <Input
                  id="loop-time"
                  type="time"
                  value={time}
                  onChange={event => {
                    const [hour, minute] = event.target.value.split(':').map(Number);
                    // A cleared field keeps the last time.
                    if (event.target.value) updateSchedule({ hour, minute });
                  }}
                  className="w-32 text-sm"
                />
              </>
            )}

            {schedule.repeat === 'custom' && (
              <>
                <label className="text-label font-medium text-text-primary" htmlFor="loop-cron">Cron</label>
                <Input
                  id="loop-cron"
                  value={schedule.cron}
                  onChange={event => updateSchedule({ cron: event.target.value })}
                  placeholder="0 3 * * *"
                  className="font-mono text-sm"
                  spellCheck={false}
                  fullWidth
                />
              </>
            )}
          </div>
          {/* One fixed-height block, so the form does not jump as the preview answers. */}
          <div className="min-h-[3.75rem] text-xs" aria-live="polite" data-testid="loop-schedule-preview">
            {preview?.ok === false && <p className="text-status-error">{preview.error}</p>}
            {preview?.ok === true && (
              <>
                <p className="text-sm font-medium text-interactive">{summary ?? preview.scheduleText}</p>
                <p className="text-text-secondary">Next runs: {preview.nextRunsAtMs.map(ms => formatRunTime(ms, true)).join(' · ')}</p>
                {schedule.repeat !== 'custom' && <p className="text-text-secondary">cron: <span className="font-mono">{cron}</span></p>}
              </>
            )}
          </div>
        </div>}

        <div className="flex gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-text-primary">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-status-warning" aria-hidden="true" />
          <span>{onSchedule
            ? 'Runs unattended with permission prompts skipped. The schedule runs at most once an hour. Keeps the last 10 runs.'
            : 'Runs unattended with permission prompts skipped. Keeps the last 10 runs.'}</span>
        </div>

        {error && <p role="alert" className="text-sm text-status-error">{error}</p>}
      </ModalBody>
      <ModalFooter className="justify-between">
        {loop && confirmingDelete ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-text-secondary">Delete this loop? Its run Panes stay.</span>
            <Button size="sm" variant="danger" onClick={() => void handleDelete()} disabled={busy}>Delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>Keep</Button>
          </div>
        ) : loop ? (
          <Button size="sm" variant="secondary" className="text-status-error" onClick={() => setConfirmingDelete(true)}>Delete loop</Button>
        ) : <span />}
        {!confirmingDelete && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={!canSave} title={missing ?? undefined}>Save</Button>
          </div>
        )}
      </ModalFooter>
    </>
  );
}

/** Creates or edits a loop, docked to the window's right edge. */
export function LoopDrawer() {
  const drawer = useLoopsStore(state => state.drawer);
  const loops = useLoopsStore(state => state.loops);
  const closeDrawer = useLoopsStore(state => state.closeDrawer);
  const loop = drawer?.loopId ? loops.find(candidate => candidate.id === drawer.loopId) : undefined;
  return (
    <Modal isOpen={drawer !== null} onClose={closeDrawer} placement="right" showCloseButton={false}>
      {/* Keyed so each opening starts from the loop as it is now. */}
      {drawer && <LoopDrawerForm key={drawer.loopId ?? 'new'} loop={loop} onClose={closeDrawer} />}
    </Modal>
  );
}
