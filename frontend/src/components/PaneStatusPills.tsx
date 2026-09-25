import { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { resolvePaneStatusPills } from '../utils/paneTitle';
import { Badge } from './ui/Badge';

/**
 * Which of `keys` appeared just now, as opposed to being here all along.
 *
 * A pill that arrives while you are watching the pane — the PR opened, the
 * branch became mergeable — is a state change, and motion is how a state
 * change stops being a thing you have to notice. A pill that is simply present
 * because you switched to a pane that already had one is not news, so switching
 * panes (a new `scope`) counts everything as pre-existing.
 */
function useArrivedKeys(scope: string | null, keys: string[]): Set<string> {
  const signature = keys.join('\u0000');
  const [seen, setSeen] = useState({ scope, signature, arrived: new Set<string>() });

  if (seen.scope !== scope || seen.signature !== signature) {
    // Render-phase update: React re-renders immediately with the value below,
    // so the commit that first paints a new pill already carries its class.
    setSeen({
      scope,
      signature,
      arrived: seen.scope === scope
        ? new Set(keys.filter(key => !seen.signature.split('\u0000').includes(key)))
        : new Set(),
    });
  }

  return seen.scope === scope && seen.signature === signature ? seen.arrived : new Set();
}

/** PR and merge-readiness pills for the title strip while the sidebar is collapsed. */
export function PaneStatusPills({ sessionId }: { sessionId: string }) {
  const session = useSessionStore(state => (
    state.activeMainRepoSession?.id === sessionId
      ? state.activeMainRepoSession
      : state.sessions.find(item => item.id === sessionId)
  ));
  const pills = resolvePaneStatusPills(session);
  const arrived = useArrivedKeys(sessionId, pills.map(pill => pill.key));
  if (pills.length === 0) return null;

  return (
    <div className="ml-auto flex flex-shrink-0 items-center gap-1 pl-2" data-testid="window-title-bar-pills">
      {pills.map(pill => (
        <Badge
          key={pill.key}
          variant={pill.variant}
          size="sm"
          className={`whitespace-nowrap px-1.5 py-0 text-[10px] leading-4${
            arrived.has(pill.key) ? ' origin-left animate-title-pill-enter' : ''
          }`}
          title={pill.tooltip}
        >
          {pill.label}
        </Badge>
      ))}
    </div>
  );
}
