import type { ChatTabProblem } from '../../../../shared/types/chatTab';

/**
 * Why a chat tab stopped and the one action that gets it going again. It never retries by itself.
 * `restart: false` leaves restarting to the tab's owner (Autopilot's Start), keeping the reason.
 */
export function ChatProblem({ problem, agent, busy, restart = true, onRestart, onSignIn, onInstall }: {
  problem: ChatTabProblem;
  agent: string;
  busy: boolean;
  restart?: boolean;
  onRestart: () => void;
  onSignIn: () => void;
  onInstall: (url: string) => void;
}) {
  // The host's next step names this card's Restart or Retry; without them it points at the owner's Start.
  const next = restart ? problem.next
    : problem.action === 'sign-in' ? 'Sign in, then press Start above.'
      : problem.action === 'install' ? `Install ${agent}, then press Start above.`
        : 'Press Start above to start it again.';
  return <section role="alert" aria-label="Chat stopped" className="chat-problem" data-code={problem.code}>
    <p className="chat-problem-title">{problem.message}</p>
    <p className="chat-problem-next">{next}</p>
    <div className="chat-problem-actions">
      {problem.action === 'sign-in' && <button type="button" className="chat-button chat-button-primary" disabled={busy} onClick={onSignIn}>Sign in in Terminal</button>}
      {problem.action === 'install' && problem.url && <button type="button" className="chat-button chat-button-primary" disabled={busy} onClick={() => onInstall(problem.url!)}>Install {agent}</button>}
      {restart && problem.code !== 'unsupported-host' && <button type="button" className={`chat-button ${problem.action === 'restart' ? 'chat-button-primary' : 'chat-button-outline'}`} disabled={busy} onClick={onRestart}>{problem.action === 'restart' ? 'Restart' : 'Retry'}</button>}
    </div>
  </section>;
}
