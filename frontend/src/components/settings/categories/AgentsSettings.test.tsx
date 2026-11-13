import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RegistryAgent, RegistryAgentList } from '../../../../../shared/types/agentRegistry';
import type { ChatAgentEntry } from '../../../../../shared/types/chatTab';
import { AgentList, RegistryAgentList as RegistryList } from './AgentsSettings';
import {
  installRegistryAgent, refreshAgentRegistry, useAgentRegistryStore, type AgentRegistryClient,
} from '../../../stores/agentRegistryStore';
import { useChatAgentsStore } from '../../../stores/chatAgentsStore';

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, '\'');

/** The markup of the registry row named `name`, up to the next row. */
function row(html: string, name: string): string {
  const start = html.indexOf(`role="listitem" aria-label="${name}"`);
  expect(start, `a row named ${name}`).toBeGreaterThan(-1);
  const next = html.indexOf('role="listitem"', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

/** Each button's visible name, marked when it is disabled. */
const buttons = (html: string) =>
  [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(([, attributes, inner]) => `${text(inner)}${attributes.includes('disabled=""') ? ' (disabled)' : ''}`);

/** The labels under the list "What <name> supports". */
function labels(html: string, name: string): string[] {
  const list = new RegExp(`<ul aria-label="What ${name} supports"[^>]*>(.*?)</ul>`).exec(html)?.[1] ?? '';
  return [...list.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(([, label]) => text(label));
}

function entry(id: string, fields: Partial<ChatAgentEntry> = {}): ChatAgentEntry {
  return { id, label: id, icon: id, source: 'config', installed: true, fullAccess: 'agent', switchFromTerminal: { ok: true }, ...fields };
}

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

const renderList = (list: RegistryAgentList, { catalog, canInstall = true }: { catalog?: ChatAgentEntry[]; canInstall?: boolean } = {}) =>
  renderToStaticMarkup(<RegistryList state={{ rows: {}, list }} catalog={catalog} canInstall={canInstall} onInstall={() => undefined} onRemove={() => undefined} />);
const renderStore = () =>
  renderToStaticMarkup(<RegistryList state={useAgentRegistryStore.getState()} catalog={undefined} canInstall onInstall={() => undefined} onRemove={() => undefined} />);

afterEach(() => {
  useAgentRegistryStore.setState({ list: undefined, rows: {}, reading: undefined, confirmUnverified: undefined });
  useChatAgentsStore.setState({ entries: undefined });
});

describe('Settings › Agents: Pane\'s own agents', () => {
  it('labels what each agent supports, who grants full access, and offers Install when it is missing', () => {
    const html = renderToStaticMarkup(<AgentList agents={[
      entry('claude', { label: 'Claude', version: '2.1.316', capabilities: { reopen: true, list: true, images: true } }),
      entry('opencode', { label: 'OpenCode', fullAccess: 'pane', installed: false, installUrl: 'https://example.test/install' }),
    ]} />);
    expect(labels(html, 'Claude')).toEqual(['Reopens chats', 'Lists past chats', 'Images', 'Full access by agent']);
    expect(text(html)).toContain('Version 2.1.316');
    // Capabilities not yet known show no labels.
    expect(labels(html, 'OpenCode')).toEqual(['Full access by Pane']);
    expect(text(html)).toContain('Not installed');
    expect(buttons(html)).toEqual(['Install']);
  });
});

describe('Settings › Agents: the ACP Registry', () => {
  it('lists each agent with its version, what it runs on, and what this computer is missing', () => {
    const html = renderList({
      error: 'Pane could not reach the ACP Registry.',
      agents: [{ ...alpha, needs: 'Node.js' }, beta, { ...gamma, installedVersion: '2.5.0' }],
    });
    expect(text(html)).toContain('This list may be out of date. Pane could not reach the ACP Registry.');

    const alphaRow = row(html, 'Alpha');
    expect(text(alphaRow)).toContain('Needs Node.js');
    expect(labels(alphaRow, 'Alpha')).toEqual(['Runs on Node.js']);
    // Install waits for Node.js.
    expect(buttons(alphaRow)).toEqual(['Install (disabled)']);

    expect(text(row(html, 'Beta'))).toContain('Version 0.9.0');
    expect(labels(html, 'Beta')).toEqual(['No checksum']);
    expect(buttons(row(html, 'Beta'))).toEqual(['Install']);

    expect(text(row(html, 'Gamma'))).toContain('Version 2.5.0, 3.0.0 on next launch');
    expect(buttons(row(html, 'Gamma'))).toEqual(['Remove']);
  });

  it('shows what Pane learned about an installed agent, from the host\'s catalog', () => {
    const html = renderList(
      { agents: [{ ...alpha, installedVersion: '1.2.0' }, beta] },
      { catalog: [entry('alpha', { source: 'registry', fullAccess: 'pane', capabilities: { reopen: true, list: false, images: true } })] },
    );
    expect(labels(html, 'Alpha')).toEqual(['Reopens chats', 'Images', 'Full access by Pane', 'Runs on Node.js']);
  });

  it('offers only Remove for an installed agent the registry no longer lists', () => {
    const html = renderList({ agents: [{ ...gamma, installedVersion: '2.5.0', listed: false }] });
    const gammaRow = row(html, 'Gamma');
    expect(text(gammaRow)).toContain('Version 2.5.0');
    expect(text(gammaRow)).not.toContain('next launch');
    expect(labels(gammaRow, 'Gamma')).toContain('No longer listed');
    expect(buttons(gammaRow)).toEqual(['Remove']);
  });

  it('offers no Install while chat tabs are off, and still offers Remove', () => {
    const html = renderList({ agents: [beta, { ...gamma, installedVersion: '3.0.0' }] }, { canInstall: false });
    expect(buttons(row(html, 'Beta'))).toEqual([]);
    expect(buttons(row(html, 'Gamma'))).toEqual(['Remove']);
  });

  it('installs an agent, shows its installed version, and refreshes the + menu', async () => {
    const client = fakeClient({ agents: [gamma] }, () => Promise.resolve({ agents: [{ ...gamma, installedVersion: '3.0.0' }] }));
    await refreshAgentRegistry(client);
    expect(buttons(row(renderStore(), 'Gamma'))).toEqual(['Install']);

    await installRegistryAgent(client, gamma);
    expect(client.installAgent).toHaveBeenCalledWith('gamma', undefined);
    expect(text(row(renderStore(), 'Gamma'))).toContain('Version 3.0.0');
    expect(buttons(row(renderStore(), 'Gamma'))).toEqual(['Remove']);
    expect(client.agents).toHaveBeenCalled();
  });

  it('keeps an install\'s list when a slower read started before it answers later', async () => {
    let answerRead: (list: RegistryAgentList) => void = () => undefined;
    const client = fakeClient({ agents: [gamma] }, () => Promise.resolve({ agents: [{ ...gamma, installedVersion: '3.0.0' }] }));
    client.registry = vi.fn(() => new Promise<RegistryAgentList>(resolve => { answerRead = resolve; }));

    const read = refreshAgentRegistry(client);
    await installRegistryAgent(client, gamma);
    answerRead({ agents: [gamma] });
    await read;
    expect(useAgentRegistryStore.getState().list?.agents[0].installedVersion).toBe('3.0.0');
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
    expect(renderStore()).not.toContain('role="alert"');
  });

  it('shows a failed install on that agent only', async () => {
    const client = fakeClient({ agents: [alpha, gamma] }, () => Promise.reject(new Error(
      "Error invoking remote method 'chat-tab:install-agent': Error [AGENT_REGISTRY_INSTALL_FAILED]: Pane could not install Gamma 3.0.0: the server answered 404. Nothing was installed. Next: Check the internet connection and try again.",
    )));
    await refreshAgentRegistry(client);

    await installRegistryAgent(client, gamma);
    const html = renderStore();
    expect(row(html, 'Gamma')).toContain('role="alert"');
    expect(text(row(html, 'Gamma'))).toContain('Pane could not install Gamma 3.0.0: the server answered 404.');
    expect(row(html, 'Alpha')).not.toContain('role="alert"');
  });
});
