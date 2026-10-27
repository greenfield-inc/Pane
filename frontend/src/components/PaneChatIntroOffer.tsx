import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { API } from '../utils/api';
import type { Project } from '../types/project';
import { capture } from '../services/posthog';
import { useConfigStore } from '../stores/configStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useSessionStore } from '../stores/sessionStore';

/** Main reads this preference too; see main/src/services/paneChatIntroOffer.ts. */
const SHOWN_PREFERENCE = 'pane_chat_intro_offer_shown';
const EVENT = 'pane_chat_intro_offer';

type Phase =
  | { kind: 'waiting' }
  | { kind: 'offer'; promptAtLaunch: boolean }
  /** `pastePrompt` is the first message for the user to paste when the launch couldn't carry it. */
  | { kind: 'tried'; sessionId: string; pastePrompt?: string }
  | { kind: 'gone' };

function openingPrompt(repository: { name: string; path: string }): string {
  return [
    `Pane sent this once, to introduce Pane Chat to someone who has been running Panes by hand in the repository ${repository.name} (${repository.path}).`,
    'In two or three short sentences, say that you can start Panes, give each one a task, and check on them while they work.',
    'Then look at the repository briefly and suggest two small, real tasks from it that could run in parallel, each in a new Pane of its own.',
    'Ask whether to start them or what else to run. Don\'t create any Panes until the user answers.',
  ].join(' ');
}

/**
 * Offers Pane Chat once, over a Pane, to someone running Panes by hand. "Try it"
 * opens a new Session whose Pane Chat suggests two tasks from the Pane's repository.
 * Main decides who qualifies; this card decides where it may show.
 */
export function PaneChatIntroOffer({ suppressed }: { suppressed: boolean }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'waiting' });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isRemoteMode = useConfigStore(state => state.config?.remoteDaemon?.client.mode === 'remote');
  const activeView = useNavigationStore(state => state.activeView);
  const navigateToPaneChat = useNavigationStore(state => state.navigateToPaneChat);
  const activeSession = useSessionStore(state => state.getActiveSession());
  const paneCount = useSessionStore(state => state.sessions.length);
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const selectedSessionId = useOrchestrationSessionStore(state => state.selectedSessionId);
  const createSession = useOrchestrationSessionStore(state => state.create);
  const refreshSessions = useOrchestrationSessionStore(state => state.refresh);
  const selectSession = useOrchestrationSessionStore(state => state.select);
  const onPane = activeView === 'sessions' && activeSession !== undefined && !activeSession.isHidden;
  // Desktop on its own host only: a desktop showing another computer's Pane never offers it.
  const offerVisible = phase.kind === 'offer' && onPane && !suppressed && isRemoteMode === false;
  const followUpVisible = phase.kind === 'tried' && activeView === 'pane-chat' && selectedSessionId === phase.sessionId;

  // Ask on launch, after a Pane is created, and when the window regains focus.
  useEffect(() => {
    if (phase.kind !== 'waiting' || isRemoteMode !== false) return;
    let cancelled = false;
    const check = () => {
      void API.paneChat.introOffer().then(response => {
        const data = response.success ? response.data : undefined;
        if (!cancelled && data?.eligible) {
          setPhase(current => current.kind === 'waiting' ? { kind: 'offer', promptAtLaunch: data.openingPromptAtLaunch } : current);
        }
      }).catch(() => undefined);
    };
    check();
    window.addEventListener('focus', check);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', check);
    };
  }, [phase.kind, isRemoteMode, paneCount]);

  // Shown means shown: once it renders, it never comes back after a restart.
  const recordedShown = useRef(false);
  useEffect(() => {
    if (!offerVisible || recordedShown.current) return;
    recordedShown.current = true;
    void API.preferences.set(SHOWN_PREFERENCE, 'true').catch(() => undefined);
    capture(EVENT, { action: 'shown' });
  }, [offerVisible]);

  // The follow-up stays only while the user is on the Session "Try it" opened.
  const leftTriedSession = phase.kind === 'tried' && !followUpVisible;
  useEffect(() => {
    if (leftTriedSession) setPhase({ kind: 'gone' });
  }, [leftTriedSession]);

  const dismiss = useCallback((action: 'not_now' | 'close') => {
    capture(EVENT, { action });
    setPhase({ kind: 'gone' });
  }, []);

  const [copied, setCopied] = useState(false);
  const promptAtLaunch = phase.kind === 'offer' && phase.promptAtLaunch;
  const tryIt = useCallback(async () => {
    if (!activeSession) return;
    setCreating(true);
    setError(null);
    try {
      const projects = await API.projects.getAll();
      const repository = projects.success ? projects.data?.find((project: Project) => project.id === activeSession.projectId) : undefined;
      if (!repository) throw new Error('this Pane\'s repository is not in Pane');
      const name = `${repository.name} tasks`;
      const prompt = openingPrompt(repository);
      const open = (sessionId: string) => {
        capture(EVENT, { action: 'try' });
        setPhase({ kind: 'tried', sessionId, pastePrompt: promptAtLaunch ? undefined : prompt });
        void setActiveSession(null);
        navigateToPaneChat();
      };
      try {
        // The built-in launch with no custom resume, so the agent always receives the opening prompt.
        // A shell that can't carry it on the launch command line gets none; the user pastes it instead.
        const view = await createSession({ name, launchCommand: '', customResume: null, openingPrompt: promptAtLaunch ? prompt : undefined });
        open(view.session.id);
      } catch (cause) {
        // Main can save the Session and then fail to open its tab; open the saved one instead of creating another.
        await refreshSessions();
        const saved = useOrchestrationSessionStore.getState().sessions.find(session => session.name === name);
        if (!saved) throw cause;
        await selectSession({ sessionId: saved.id });
        open(saved.id);
      }
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      setError(`Pane Chat could not start: ${reason}. No Session was opened. Try again.`);
    } finally {
      setCreating(false);
    }
  }, [activeSession, createSession, navigateToPaneChat, promptAtLaunch, refreshSessions, selectSession, setActiveSession]);

  const copyPrompt = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => undefined);
  }, []);

  if (!offerVisible && !followUpVisible) return null;

  return (
    <section
      aria-label="Pane Chat offer"
      className="absolute right-4 top-20 z-30 w-[300px] rounded-lg border border-border-primary bg-surface-primary p-4 text-text-primary shadow-dropdown"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={() => offerVisible ? dismiss('close') : setPhase({ kind: 'gone' })}
        className="absolute right-2 top-2 rounded p-1 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
      <div className="flex items-center gap-2 pr-6">
        <Badge variant="primary" size="sm" className="py-0.5">New</Badge>
        <h2 className="text-sm font-semibold">Let an agent run your Panes</h2>
      </div>
      <p className="mt-1.5 text-sm text-text-secondary">Pane Chat starts Panes, sends tasks and checks on them for you.</p>
      {error && offerVisible && <p role="alert" className="mt-2 text-sm text-status-error [overflow-wrap:anywhere]">{error}</p>}
      {followUpVisible && phase.pastePrompt && (
        <div className="mt-3">
          <p className="text-sm text-text-secondary">Paste its first message into Pane Chat to start.</p>
          <Button size="sm" className="mt-2 min-w-[10rem]" onClick={() => copyPrompt(phase.pastePrompt ?? '')}>{copied ? 'Copied' : 'Copy first message'}</Button>
        </div>
      )}
      {offerVisible && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => void tryIt()} loading={creating} loadingText="Starting…">Try it</Button>
          <Button size="sm" variant="ghost" onClick={() => dismiss('not_now')} disabled={creating}>Not now</Button>
        </div>
      )}
    </section>
  );
}
