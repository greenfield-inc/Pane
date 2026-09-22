import { test, expect } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';

type CapturedPostHogRequest = {
  url: string;
  body: Buffer;
};

type CapturedPostHogEvent = {
  event?: string;
  properties?: JsonObject;
  $set?: JsonObject;
};

type CapturedPostHogPayload = CapturedPostHogEvent[] | (CapturedPostHogEvent & { batch?: CapturedPostHogEvent[] });

function parseCapturedEvents(requests: CapturedPostHogRequest[]): CapturedPostHogEvent[] {
  return requests.flatMap((request) => {
    try {
      const body = parsePostHogBody(request.body);
      if (Array.isArray(body)) {
        return body;
      }
      if (Array.isArray(body.batch)) {
        return body.batch;
      }
      return [body];
    } catch {
      return [];
    }
  });
}

function parsePostHogBody(body: Buffer): CapturedPostHogPayload {
  const bodyText = (body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString('utf8');
  try {
    // SAFETY: captured PostHog requests are decoded into the fixture's constrained event shape.
    return JSON.parse(bodyText) as CapturedPostHogPayload;
  } catch {
    const data = new URLSearchParams(bodyText).get('data');
    // SAFETY: captured PostHog requests are decoded into the fixture's constrained event shape.
    return data
      ? JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as CapturedPostHogPayload
      : {};
  }
}

test.beforeEach(async ({ page }) => {
  // Exercise desktop capture; the SDK drops WebDriver and HeadlessChrome client hints.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // SAFETY: Chromium exposes these optional structured user-agent client hints.
    const clientHints = (navigator as Navigator & {
      userAgentData?: { brands: Array<{ brand: string; version: string }> };
    }).userAgentData;
    if (clientHints) {
      Object.defineProperty(clientHints, 'brands', {
        value: clientHints.brands.filter((entry) => entry.brand !== 'HeadlessChrome'),
      });
      Object.defineProperty(navigator, 'userAgentData', { value: clientHints });
    }
  });
  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' })
  );
});

test('bundled analytics preserves identity and opt-out without loading remote code', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('Analytics network verification requires a base URL');
  const appOrigin = new URL(baseURL).origin;
  const identity = {
    distinctId: 'install:install_default_e2e',
    installId: 'install_default_e2e',
    identitySource: 'anonymous',
    appVersion: '2.1.2-test',
    platform: 'linux',
    electronVersion: 'test-electron',
    webDistinctId: 'web_default_e2e',
    webAttributionPresent: true,
    isFirstLaunch: true,
    previousVersion: null,
  };
  const requests: CapturedPostHogRequest[] = [];
  const remoteScripts: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script' && new URL(request.url()).origin !== appOrigin) {
      remoteScripts.push(request.url());
    }
  });

  await page.route('http://posthog.test/**', async (route) => {
    requests.push({
      url: route.request().url(),
      body: route.request().postDataBuffer() ?? Buffer.alloc(0),
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Exercise the SDK's JSON configuration path with features that would
      // otherwise lazy-load executable extensions from the analytics host.
      body: JSON.stringify({
        hasFeatureFlags: false,
        supportedCompression: ['gzip-js'],
        surveys: true,
        sessionRecording: { endpoint: '/s/', recorderVersion: 'v2' },
        autocaptureExceptions: true,
      }),
    });
  });

  await installElectronApiMock(page, {
    analyticsConsentShown: false,
    initialPreferences: { analytics_default_applied: 'false' },
    analyticsIdentity: identity,
    initialConfig: {
      analytics: {
        enabled: false,
        posthogApiKey: 'phc_test',
        posthogHost: 'http://posthog.test',
        installId: identity.installId,
        distinctId: identity.distinctId,
        identitySource: identity.identitySource,
      },
    },
    mainAnalyticsEvents: [
      {
        eventName: 'app_opened',
        properties: { is_first_launch: true },
      },
    ],
  });

  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await expect(page.getByRole('button', { name: 'Settings' }).first()).toBeVisible({ timeout: 15000 });

  await expect.poll(() => parseCapturedEvents(requests).map((event) => event.event)).toEqual(
    expect.arrayContaining(['analytics_default_enabled', 'app_first_opened'])
  );

  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Privacy', exact: true }).click();
  await expect(page.getByText('Product analytics are on by default.')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Allow product analytics' })).toBeChecked();
  await expect.poll(() => parseCapturedEvents(requests).map((event) => event.event)).toContain('analytics_settings_disclosure_viewed');

  await expect.poll(() => parseCapturedEvents(requests).map((event) => event.event)).toEqual(
    expect.arrayContaining(['$identify', '$autocapture'])
  );
  const identified = parseCapturedEvents(requests).find((event) => event.event === '$identify');
  expect(identified?.properties?.distinct_id).toBe(identity.distinctId);
  expect(identified?.$set).toMatchObject({ install_id: identity.installId });
  expect(requests.some((request) => new URL(request.url).pathname === '/array/phc_test/config')).toBe(true);
  expect(remoteScripts).toEqual([]);

  await page.getByRole('switch', { name: 'Allow product analytics' }).click();

  await expect.poll(() => parseCapturedEvents(requests).map((event) => event.event)).toEqual(
    expect.arrayContaining(['analytics_default_enabled', 'app_first_opened', 'analytics_settings_disclosure_viewed', 'analytics_opted_out'])
  );
  await expect(page.getByRole('switch', { name: 'Allow product analytics' })).not.toBeChecked();

  const events = parseCapturedEvents(requests);
  const defaultEnabled = events.find((event) => event.event === 'analytics_default_enabled');
  const firstOpened = events.find((event) => event.event === 'app_first_opened');
  const optedOut = events.find((event) => event.event === 'analytics_opted_out');

  for (const event of [defaultEnabled, firstOpened, optedOut]) {
    expect(event?.properties).toMatchObject({
      distinct_id: identity.distinctId,
      install_id: identity.installId,
      identity_source: identity.identitySource,
      app_version: identity.appVersion,
      platform: identity.platform,
    });
    expect(event?.properties?.$set).toMatchObject({
      install_id: identity.installId,
      app_version: identity.appVersion,
      platform: identity.platform,
    });
  }

  expect(firstOpened?.properties).toMatchObject({
    source: 'web_attribution',
    web_attributed: true,
    web_attribution_present: true,
    is_first_launch: true,
  });
  expect(remoteScripts).toEqual([]);
});

test('an explicit existing opt-out stays disabled and receives no default-on events', async ({ page }) => {
  const identity = {
    distinctId: 'install:install_existing_opt_out_e2e',
    installId: 'install_existing_opt_out_e2e',
    identitySource: 'anonymous',
    appVersion: '2.1.2-test',
    platform: 'linux',
    electronVersion: 'test-electron',
    webAttributionPresent: false,
    isFirstLaunch: false,
    previousVersion: '2.1.1-test',
  };
  const requests: CapturedPostHogRequest[] = [];

  await page.route('http://posthog.test/**', async (route) => {
    requests.push({
      url: route.request().url(),
      body: route.request().postDataBuffer() ?? Buffer.alloc(0),
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    });
  });

  await installElectronApiMock(page, {
    analyticsConsentShown: true,
    analyticsIdentity: identity,
    initialConfig: {
      analytics: {
        enabled: false,
        posthogApiKey: 'phc_test',
        posthogHost: 'http://posthog.test',
        installId: identity.installId,
        distinctId: identity.distinctId,
        identitySource: identity.identitySource,
      },
    },
    mainAnalyticsEvents: [
      {
        eventName: 'app_opened',
        properties: { is_first_launch: false },
      },
    ],
  });

  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Privacy', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Allow product analytics' })).not.toBeChecked();
  const eventNames = parseCapturedEvents(requests).map((event) => event.event);
  for (const eventName of ['analytics_default_enabled', 'app_opened', '$identify', '$autocapture']) {
    expect(eventNames).not.toContain(eventName);
  }
});
