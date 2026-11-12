import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsIdentity } from '../types/config';
import {
  aliasInstallIdentity,
  aliasInstallIdentityDirect,
  aliasWebVisitor,
  aliasWebVisitorDirect,
  capture,
  captureAppFirstOpened,
  initPostHog,
  posthog,
  type AnalyticsProperties,
} from './posthog';

interface AliasEvent {
  distinct_id: string;
  alias: string;
}

// The real posthog.alias builds the $create_alias payload; capture is where the
// SDK would send it.
const sdkAliasEvents: AliasEvent[] = [];
const directAliasEvents: AliasEvent[] = [];
const sdkEvents: Array<{ event: string; properties: AnalyticsProperties }> = [];
const directEvents: Array<{ event: string; properties: AnalyticsProperties }> = [];

beforeEach(() => {
  sdkAliasEvents.length = 0;
  directAliasEvents.length = 0;
  sdkEvents.length = 0;
  directEvents.length = 0;
  vi.spyOn(posthog, 'capture').mockImplementation((event, properties) => {
    sdkEvents.push({ event, properties: properties ?? {} });
    if (event === '$create_alias' && properties) {
      sdkAliasEvents.push({ distinct_id: properties.distinct_id, alias: properties.alias });
    }
    return undefined;
  });
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const { event, properties } = JSON.parse(init.body);
    directEvents.push({ event, properties });
    if (event === '$create_alias') {
      directAliasEvents.push({ distinct_id: properties.distinct_id, alias: properties.alias });
    }
    return new Response();
  });
});

const firstLaunch: AnalyticsIdentity = {
  distinctId: 'email:dev@example.com',
  identitySource: 'email',
  installId: 'install_abc',
  webDistinctId: 'web-visitor-1',
};

const desktopIdChanged: AnalyticsIdentity = {
  distinctId: 'email:dev@example.com',
  previousDistinctId: 'install:install_abc',
  identitySource: 'email',
  installId: 'install_abc',
};

const anonymous: AnalyticsIdentity = {
  distinctId: 'install:install_abc',
  identitySource: 'anonymous',
  installId: 'install_abc',
  webDistinctId: 'web-visitor-1',
};

// PostHog refuses an alias whose person is already identified, so the alias is
// always the id that is new to this person.
describe('$create_alias payloads', () => {
  it('merges the web visitor and the install id into the desktop id on first launch', async () => {
    aliasInstallIdentity(firstLaunch);
    aliasWebVisitor(firstLaunch.webDistinctId, firstLaunch.distinctId);
    await aliasInstallIdentityDirect(firstLaunch);
    await aliasWebVisitorDirect(firstLaunch);

    const expected = [
      { distinct_id: 'email:dev@example.com', alias: 'install:install_abc' },
      { distinct_id: 'email:dev@example.com', alias: 'web-visitor-1' },
    ];
    expect(sdkAliasEvents).toEqual(expected);
    expect(directAliasEvents).toEqual(expected);
  });

  it('merges a new desktop id into the install id after the desktop id changes', async () => {
    aliasInstallIdentity(desktopIdChanged);
    await aliasInstallIdentityDirect(desktopIdChanged);

    const expected = [{ distinct_id: 'install:install_abc', alias: 'email:dev@example.com' }];
    expect(sdkAliasEvents).toEqual(expected);
    expect(directAliasEvents).toEqual(expected);
  });

  it('sends no install alias when the desktop id is the install id', async () => {
    aliasInstallIdentity(anonymous);
    aliasWebVisitor(anonymous.webDistinctId, anonymous.distinctId);
    await aliasInstallIdentityDirect(anonymous);
    await aliasWebVisitorDirect(anonymous);

    const expected = [{ distinct_id: 'install:install_abc', alias: 'web-visitor-1' }];
    expect(sdkAliasEvents).toEqual(expected);
    expect(directAliasEvents).toEqual(expected);
  });
});

describe('environment tags', () => {
  const tags = {
    ci: true, ci_provider: 'github_actions', container: true, display: 'virtual' as const,
    in_wsl: false, packaged: true, custom_pane_dir: false, automated: true,
  };
  const ciInstall: AnalyticsIdentity = {
    distinctId: 'install:install_ci', identitySource: 'anonymous', installId: 'install_ci',
    isFirstLaunch: true, environment: tags,
  };

  it('tags app_first_opened and every SDK event, such as app_opened, with where Pane runs', async () => {
    await captureAppFirstOpened(ciInstall);
    expect(directEvents.find((e) => e.event === 'app_first_opened')?.properties).toMatchObject(tags);

    initPostHog({ enabled: false, identity: ciInstall });
    capture('app_opened', { is_first_launch: true });
    expect(sdkEvents.find((e) => e.event === 'app_opened')?.properties).toMatchObject(tags);
  });

  it('sends no environment tags when the main process sent none (older builds)', async () => {
    await captureAppFirstOpened({ ...ciInstall, environment: undefined });
    const firstOpens = directEvents.filter((e) => e.event === 'app_first_opened');
    expect(firstOpens).toHaveLength(1);
    expect(firstOpens[0].properties).toMatchObject({ install_id: 'install_ci', source: 'first_launch' });
    for (const key of Object.keys(tags)) expect(firstOpens[0].properties).not.toHaveProperty(key);
  });
});
