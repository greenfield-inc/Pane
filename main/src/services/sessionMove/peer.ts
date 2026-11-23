import os from 'os';
import { app } from 'electron';
import { boundary as runpaneBoundary } from '../../../../packages/runpane/src/boundaryDecoder';
import { invokeDaemon, invokeRemoteDaemon, PaneDaemonClientError, type RemoteDaemonTarget, type RemoteRoute } from '../../../../packages/runpane/src/daemonClient';
import { PaneError } from '../../../../shared/paneError';
import { boundary, decodeBoundary, type BoundarySchema, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { callWorkspace, locateTailnetCandidate, readTailscaleStatus, savedSecretKey, savedWorkspaceSecrets } from '../tailnetMachines';
import { normalizeRemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import { routesReachableHere, type RemoteComputer } from '../../../../shared/types/remoteComputers';
import { asTargetAnswer, TargetAnswerError } from './afterFreeze';
import type { ConfigManager } from '../configManager';

/** The other Pane in a move: one call on its daemon at a time, each with its own deadline. */
export interface MovePeer {
  name: string;
  invoke<T>(channel: string, args: JsonValue[], schema: BoundarySchema<T>, timeoutMs: number): Promise<T>;
}

/** Largest answer a move call returns (a preflight or status); chunks only go the other way. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Loopback test machines, for QA of two isolated Pane instances on one computer (D-288): a JSON
 * list of `{ "name": "...", "paneDir": "..." }` in PANE_MOVE_TEST_PEERS. Each is reached through
 * its own daemon socket, never over the network. Packaged builds ignore it.
 */
export function testPeers(env: NodeJS.ProcessEnv = process.env, packaged = app?.isPackaged ?? true): Array<{ name: string; paneDir: string }> {
  if (packaged || !env.PANE_MOVE_TEST_PEERS) return [];
  try {
    return decodeBoundary(JSON.parse(env.PANE_MOVE_TEST_PEERS), boundary.array(boundary.object({ name: boundary.nonEmptyString, paneDir: boundary.nonEmptyString })));
  } catch (error) {
    console.warn('[SessionMove] PANE_MOVE_TEST_PEERS is not a list of { name, paneDir }:', error);
    return [];
  }
}

function socketPeer(name: string, paneDir: string): MovePeer {
  return {
    name,
    async invoke(channel, args, schema, timeoutMs) {
      const result = await invokeDaemon(channel, args, runpaneBoundary.json, { paneDir, timeoutMs }).catch(error => {
        throw error instanceof Error ? asTargetAnswer(error) : error;
      });
      return decodeBoundary(result, schema);
    },
  };
}

function tailnetPeer(name: string, configManager: Pick<ConfigManager, 'getConfig'>): MovePeer {
  return {
    name,
    async invoke(channel, args, schema, timeoutMs) {
      const { candidate, domain, mine } = await locateTailnetCandidate(name, readTailscaleStatus);
      if (!mine) {
        throw new PaneError('ERR_MOVE_TEAMMATE_MACHINE', `${name} is a teammate's machine, and a whole Session moves only between your own machines. Nothing was sent.`, 'Use Hand off with a note… to hand the work to them instead.');
      }
      const profiles = normalizeRemoteDaemonConfig(configManager.getConfig().remoteDaemon).client.profiles;
      const secret = savedWorkspaceSecrets(profiles).get(savedSecretKey(domain, candidate.name));
      const answer = await callWorkspace(candidate, channel, args, secret, { timeoutMs, maxResponseBytes: MAX_RESPONSE_BYTES });
      if (answer.kind === 'unreachable') {
        throw new PaneError('ERR_MOVE_UNREACHABLE', `Pane on ${name} didn't answer (${answer.detail}).`, `Check that Pane is open on ${name} and that it is on your tailnet, then try again.`);
      }
      if (!answer.ok) {
        if (answer.statusCode === 404 && answer.code === 'ERR_UNKNOWN_CHANNEL') {
          throw new PaneError('ERR_MOVE_TARGET_OUTDATED', `Pane on ${name} is too old to receive a Session move.`, `Update Pane on ${name}, then try again.`);
        }
        // Pane on the target answered, with an error.
        throw new TargetAnswerError(answer.code ?? 'ERR_MOVE_TARGET_FAILED', answer.message ?? `${name} refused the call (HTTP ${answer.statusCode}).`, `Check Pane on ${name}, then try again.`);
      }
      return decodeBoundary(answer.result ?? null, schema);
    },
  };
}

/**
 * A saved computer's routes as runpane tries them: Same network routes only on this network, and
 * no SSH route (it needs a tunnel this Pane opens only for its own connection).
 */
function computerTarget(computer: RemoteComputer): RemoteDaemonTarget {
  const interfaces = Object.values(os.networkInterfaces()).flatMap(entries => entries ?? []);
  const routes = routesReachableHere(computer.routes.filter(route => route.kind !== 'ssh'), interfaces).map(route => {
    const remote: RemoteRoute = { kind: route.kind, baseUrl: route.baseUrl };
    if (route.token) remote.token = route.token;
    if (route.relay) remote.fingerprint = route.relay.fingerprint;
    return remote;
  });
  return { machine: computer.label, routes };
}

/** A computer saved in Settings › Remote Access, reached over its own routes (Pane relay, same network, public URL). */
function computerPeer(name: string, computerId: string, configManager: Pick<ConfigManager, 'getConfig'>): MovePeer {
  return {
    name,
    async invoke(channel, args, schema, timeoutMs) {
      const computer = normalizeRemoteDaemonConfig(configManager.getConfig().remoteDaemon).client.computers.find(candidate => candidate.id === computerId);
      if (!computer) {
        throw new PaneError('ERR_MOVE_UNKNOWN_COMPUTER', `${name} is no longer saved on this computer, so Pane can't reach it. Nothing was sent.`, 'Link it again in Settings › Remote Access › Computers, then try again.');
      }
      try {
        return decodeBoundary(await invokeRemoteDaemon(computerTarget(computer), channel, args, runpaneBoundary.json, timeoutMs), schema);
      } catch (error) {
        if (!(error instanceof PaneDaemonClientError)) throw error;
        if (error.code === 'ERR_WORKSPACE_UNREACHABLE' || error.code === 'ERR_WORKSPACE_TIMEOUT' || !error.code) {
          throw new PaneError('ERR_MOVE_UNREACHABLE', `Pane on ${name} didn't answer (${error.message.replace(/\.+$/, '')}).`, `Check that Pane is open on ${name}, then try again.`);
        }
        if (error.code === 'ERR_UNKNOWN_CHANNEL') {
          throw new PaneError('ERR_MOVE_TARGET_OUTDATED', `Pane on ${name} is too old to receive a Session move.`, `Update Pane on ${name}, then try again.`);
        }
        // Pane on the target answered, with an error.
        throw new TargetAnswerError(error.code, error.message, error.next ?? `Check Pane on ${name}, then try again.`);
      }
    },
  };
}

/**
 * The peer for a target: a loopback test peer with that name, else the saved computer `computerId`
 * names (reached over its own routes), else the tailnet machine with that name.
 */
export function resolvePeer(name: string, configManager: Pick<ConfigManager, 'getConfig'>, computerId?: string): MovePeer {
  const test = testPeers().find(peer => peer.name === name);
  if (test) return socketPeer(test.name, test.paneDir);
  return computerId ? computerPeer(name, computerId, configManager) : tailnetPeer(name, configManager);
}
