import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { AgentLaunchPresetId } from '../../../shared/constants/agentLaunchPresets';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

/** `checking` until the first answer; `unknown` when the agent's status command gave none. */
export type AgentReadiness = 'checking' | 'ready' | 'signed-out' | 'not-installed' | 'unknown';

/** Readiness of each agent preset. */
export interface AgentReadinessByAgent {
  claude: AgentReadiness;
  codex: AgentReadiness;
  cursor: AgentReadiness;
  opencode: AgentReadiness;
}

const CACHE_TTL_MS = 60_000;

const doctorResultSchema = boundary.object({
  available: boundary.boolean,
  signIn: boundary.optional(boundary.enumeration('signed-in', 'signed-out', 'unknown')),
});

interface CheckedReadiness {
  readiness: AgentReadiness;
  checkedAt: number;
}

interface ReadinessState {
  byProject: Record<number, Partial<Record<AgentLaunchPresetId, CheckedReadiness>>>;
}

const useReadinessStore = create<ReadinessState>(() => ({ byProject: {} }));
const inFlight = new Map<string, Promise<AgentReadiness>>();

async function checkAgent(projectId: number, agent: AgentLaunchPresetId): Promise<AgentReadiness> {
  try {
    const response = await window.electronAPI.invoke('runpane:agents:doctor', { agent, repo: { id: projectId } });
    const result = decodeOptionalBoundary(response, doctorResultSchema);
    if (!result) return 'unknown';
    if (!result.available) return 'not-installed';
    if (result.signIn === 'signed-in') return 'ready';
    return result.signIn === 'signed-out' ? 'signed-out' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Re-check the agents for a project in parallel, one runpane agent doctor each
 * (install and sign-in, run where the project's agents run). Concurrent
 * callers share a check that is already running.
 */
function refreshAgentReadiness(projectId: number, agents: readonly AgentLaunchPresetId[]): Promise<void> {
  return Promise.all(agents.map(async agent => {
    const key = `${projectId}:${agent}`;
    let check = inFlight.get(key);
    if (!check) {
      check = checkAgent(projectId, agent).finally(() => inFlight.delete(key));
      inFlight.set(key, check);
    }
    const readiness = await check;
    useReadinessStore.setState(state => ({
      byProject: { ...state.byProject, [projectId]: { ...state.byProject[projectId], [agent]: { readiness, checkedAt: Date.now() } } },
    }));
  })).then(() => undefined);
}

/**
 * Each agent's readiness for a project. An answer under a minute old when the
 * caller mounts shows at once, and stays while it is mounted; every mount also
 * re-checks in the background, so a sign-in finished meanwhile shows within
 * one check.
 */
export function useAgentReadiness(
  projectId: number | undefined,
  agents: readonly AgentLaunchPresetId[],
): AgentReadinessByAgent {
  const cached = useReadinessStore(state => (projectId === undefined ? undefined : state.byProject[projectId]));
  const agentKey = agents.join(',');
  // Answers count from a minute before this caller mounted, so a long-open card or picker never falls back to checking.
  const mountKey = `${projectId}:${agentKey}`;
  const [mount, setMount] = useState(() => ({ key: mountKey, freshSince: Date.now() - CACHE_TTL_MS }));
  if (mount.key !== mountKey) setMount({ key: mountKey, freshSince: Date.now() - CACHE_TTL_MS });
  const { freshSince } = mount;

  useEffect(() => {
    if (projectId === undefined || agentKey === '') return;
    // SAFETY: agentKey joins ids from `agents`, which are AgentLaunchPresetId values.
    void refreshAgentReadiness(projectId, agentKey.split(',') as AgentLaunchPresetId[]);
  }, [projectId, agentKey]);

  const answer = (agent: AgentLaunchPresetId): AgentReadiness => {
    const checked = cached?.[agent];
    return checked && checked.checkedAt >= freshSince ? checked.readiness : 'checking';
  };
  return { claude: answer('claude'), codex: answer('codex'), cursor: answer('cursor'), opencode: answer('opencode') };
}
