import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RegistryAgent, RegistryAgentList } from '../../../../../shared/types/agentRegistry';
import { RegistryAgentList as RegistryList } from './AgentsSettings';
import {
  installRegistryAgent, refreshAgentRegistry, useAgentRegistryStore, type AgentRegistryClient,
} from '../../../stores/agentRegistryStore';
import { useChatAgentsStore } from '../../../stores/chatAgentsStore';

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, '\'');

const alpha: RegistryAgent = { id: 'alpha', name: 'Alpha', version: '1.2.0', description: 'An agent on npm.', iconUrl: 'https://example.test/alpha.svg', kind: 'npx', verified: true };
const beta: RegistryAgent = { id: 'beta', name: 'Beta', version: '0.9.0', iconUrl: 'https://example.test/beta.svg', kind: 'binary', verified: false };
const gamma: RegistryAgent = { id: 'gamma', name: 'Gamma', version: '3.0.0', iconUrl: 'https://example.test/gamma.svg', kind: 'binary', verified: true };

function fakeClient(list: RegistryAgentList, installAgent: AgentRegistryClient['installAgent']): AgentRegistryClient {
  return {
    registry: vi.fn(() => Promise.resolve(list)),
    installAgent: vi.fn(installAgent),
    removeAgent: vi.fn(() => Promise.resolve(list)),
    agents: vi.fn(() => Promise.resolve([])),
  };
}

const render = () => renderToStaticMarkup(<RegistryList state={useAgentRegistryStore.getState()} onInstall={() => undefined} onRemove={() => undefined} />);

afterEach(() => {
  useAgentRegistryStore.setState({ list: undefined, rows: {}, confirmUnverified: undefined });
  useChatAgentsStore.setState({ entries: undefined });
});

describe('Settings › Agents: the ACP Registry', () => {
  it('lists each agent with its version, what it runs on, and what this computer is missing', () => {
    const html = renderToStaticMarkup(<RegistryList
      state={{ rows: {}, list: {
        error: 'Pane could not reach the ACP Registry.',
        agents: [
          { ...alpha, needs: 'Node.js' },
          beta,
          { ...gamma, installedVersion: '2.5.0' },
        ],
      } }}
      onInstall={() => undefined}
      onRemove={() => undefined}
    />);
    expect(text(html)).toContain('This list may be out of date. Pane could not reach the ACP Registry.');
    expect(text(html)).toContain('AlphaAn agent on npm.Needs Node.jsInstallRuns on Node.js');
    expect(text(html)).toContain('BetaVersion 0.9.0InstallNo checksum');
    expect(text(html)).toContain('GammaVersion 2.5.0, 3.0.0 on next launchRemove');
    expect(html).toContain('url(&quot;https://example.test/gamma.svg&quot;)');
    // Install waits for Node.js.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Install<\/span><\/button>/);
  });

  it('installs an agent, shows its installed version, and refreshes the + menu', async () => {
    const client = fakeClient({ agents: [gamma] }, () => Promise.resolve({ agents: [{ ...gamma, installedVersion: '3.0.0' }] }));
    await refreshAgentRegistry(client);
    expect(text(render())).toContain('GammaVersion 3.0.0Install');

    await installRegistryAgent(client, gamma);
    expect(client.installAgent).toHaveBeenCalledWith('gamma', undefined);
    expect(text(render())).toContain('GammaVersion 3.0.0Remove');
    expect(client.agents).toHaveBeenCalled();
  });

  it('asks before installing a download with no checksum, and installs only once allowed', async () => {
    const client = fakeClient({ agents: [beta] }, () => Promise.resolve({ agents: [{ ...beta, installedVersion: '0.9.0' }] }));
    await refreshAgentRegistry(client);

    await installRegistryAgent(client, beta);
    expect(client.installAgent).not.toHaveBeenCalled();
    expect(useAgentRegistryStore.getState().confirmUnverified?.id).toBe('beta');

    await installRegistryAgent(client, beta, true);
    expect(client.installAgent).toHaveBeenCalledWith('beta', { allowUnverified: true });
    expect(useAgentRegistryStore.getState().confirmUnverified).toBeUndefined();
  });

  it('asks when the host finds no checksum the list did not show', async () => {
    const client = fakeClient({ agents: [gamma] }, () => Promise.reject(new Error(
      "Error invoking remote method 'chat-tab:install-agent': Error [AGENT_REGISTRY_UNVERIFIED]: The ACP Registry publishes no checksum for Gamma. Next: Install it again to allow it.",
    )));
    await refreshAgentRegistry(client);

    await installRegistryAgent(client, gamma);
    expect(useAgentRegistryStore.getState().confirmUnverified?.id).toBe('gamma');
    expect(render()).not.toContain('role="alert"');
  });

  it('shows a failed install on that agent only', async () => {
    const client = fakeClient({ agents: [alpha, gamma] }, () => Promise.reject(new Error(
      "Error invoking remote method 'chat-tab:install-agent': Error [AGENT_REGISTRY_DOWNLOAD]: Pane could not download Gamma: the server answered 404. Next: Try Install again later.",
    )));
    await refreshAgentRegistry(client);

    await installRegistryAgent(client, gamma);
    const visible = text(render());
    expect(visible).toContain('GammaVersion 3.0.0InstallPane could not download Gamma: the server answered 404. Next: Try Install again later.');
    expect(visible.match(/Pane could not download/g)).toHaveLength(1);
  });
});
