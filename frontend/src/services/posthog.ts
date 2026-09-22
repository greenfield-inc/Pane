import posthog from 'posthog-js/dist/module.no-external';
import type { AnalyticsIdentity } from '../types/config';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';

const DEFAULT_API_KEY = 'phc_wir25CCsjr2NsZGEdlWNdvwcNG1XDjhxc9RyL5KDCf1';
const DEFAULT_HOST = 'https://runpane.com/api/c';

let currentApiKey: string | undefined;
let currentHost: string | undefined;
let currentEnabled: boolean | undefined;
let currentIdentity: AnalyticsIdentity | undefined;

type AnalyticsPropertyValue = JsonValue | undefined;
export interface AnalyticsProperties { [key: string]: AnalyticsPropertyValue }

export interface PendingAnalyticsEvent {
  eventName: string;
  properties?: AnalyticsProperties;
}

let pendingEvents: PendingAnalyticsEvent[] = [];

export interface PostHogConfig {
  enabled: boolean;
  posthogApiKey?: string;
  posthogHost?: string;
  identity?: AnalyticsIdentity;
}

export interface PostHogInitOptions {
  flushPendingEvents?: boolean;
}

interface CompactAnalyticsProperties {
  [key: string]: JsonValue;
}

interface DirectCaptureTarget {
  token: string;
  host: string;
  distinctId: string;
}

function compactProperties(properties: AnalyticsProperties): CompactAnalyticsProperties {
  const compacted: CompactAnalyticsProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) compacted[key] = value;
  }
  return compacted;
}

function personProperties(identity?: AnalyticsIdentity): Record<string, JsonValue> {
  if (!identity) return {};

  return compactProperties({
    install_id: identity.installId,
    identity_source: identity.identitySource,
    github_username: identity.githubUsername,
    github_email: identity.githubEmail,
    git_email: identity.gitEmail,
    git_email_sha256: identity.gitEmailHash,
    git_user_name: identity.gitUserName,
    app_version: identity.appVersion,
    platform: identity.platform,
  });
}

function contextProperties(identity = currentIdentity): Record<string, JsonValue> {
  if (!identity) return {};

  return compactProperties({
    install_id: identity.installId,
    identity_source: identity.identitySource,
    github_username: identity.githubUsername,
    git_email_sha256: identity.gitEmailHash,
    app_version: identity.appVersion,
    platform: identity.platform,
    electron_version: identity.electronVersion,
    web_attributed: Boolean(identity.webDistinctId || identity.webAttributionPresent),
    web_attribution_present: identity.webAttributionPresent,
    is_first_launch: identity.isFirstLaunch,
    previous_version: identity.previousVersion,
  });
}

function installDistinctId(identity = currentIdentity): string | undefined {
  if (!identity?.installId) return undefined;

  const distinctId = `install:${identity.installId}`;
  return distinctId === identity.distinctId ? undefined : distinctId;
}

function identifyUser(config: PostHogConfig): void {
  currentIdentity = config.identity;
  if (!config.enabled || !config.identity) return;

  posthog.identify(config.identity.distinctId, personProperties(config.identity));
}

function directCaptureTarget(identity = currentIdentity): DirectCaptureTarget {
  const posthogDistinctId = posthog.get_distinct_id?.();

  return {
    token: currentApiKey || DEFAULT_API_KEY,
    host: currentHost || DEFAULT_HOST,
    distinctId:
      identity?.distinctId
        ? identity.distinctId
        : posthogDistinctId
        ? posthogDistinctId
        : `anon_${crypto.randomUUID()}`,
  };
}

async function directCapture(
  eventName: string,
  properties?: AnalyticsProperties,
  identity = currentIdentity,
  options: { processPersonProfile?: boolean; distinctId?: string } = {}
): Promise<void> {
  const { token, host, distinctId } = directCaptureTarget(identity);
  const eventDistinctId =
    options.distinctId
      ? options.distinctId
      : distinctId;
  const shouldProcessPersonProfile = Boolean(options.processPersonProfile && identity);

  const payload = {
    api_key: token,
    event: eventName,
    properties: compactProperties({
      ...contextProperties(identity),
      ...properties,
      distinct_id: eventDistinctId,
      token,
      $lib: 'posthog-js',
      ...(shouldProcessPersonProfile
        ? { $set: personProperties(identity) }
        : { $process_person_profile: false }),
    }),
    timestamp: new Date().toISOString(),
  };

  try {
    await fetch(`${host.replace(/\/$/, '')}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch (error) {
    console.error(`[PostHog] Failed to capture ${eventName}:`, error);
  }
}

export function initPostHog(config: PostHogConfig, options: PostHogInitOptions = {}): void {
  const apiKey = config.posthogApiKey || DEFAULT_API_KEY;
  const host = config.posthogHost || DEFAULT_HOST;

  const needsInit = currentApiKey !== apiKey || currentHost !== host;

  if (needsInit) {
    posthog.init(apiKey, {
      api_host: host,
      // Keep executable analytics code inside the reviewed, lockfile-pinned bundle.
      // The no-external entry uses JSON for remote configuration instead of config.js.
      disable_external_dependency_loading: true,
      // Restrict autocapture to interactive elements only — prevents capturing
      // sensitive text content (code, prompts) from non-interactive UI areas
      autocapture: {
        css_selector_allowlist: [
          'button',
          'a',
          '[role="button"]',
          '[role="tab"]',
          '[role="menuitem"]',
          'input[type="checkbox"]',
          'input[type="radio"]',
          'select',
        ],
      },
      capture_pageview: true,
      persistence: 'localStorage',
      opt_out_capturing_by_default: true,
    });

    currentApiKey = apiKey;
    currentHost = host;
  }

  // SDK already initialized with same key/host — just sync opt-in state.
  if (currentEnabled !== config.enabled) {
    if (config.enabled) {
      posthog.opt_in_capturing();
    } else {
      posthog.opt_out_capturing();
    }
    currentEnabled = config.enabled;
  }

  identifyUser(config);

  if (config.enabled && options.flushPendingEvents !== false) {
    flushPendingEvents();
  }
}

export function queuePendingEvent(event: PendingAnalyticsEvent): void {
  pendingEvents.push({
    eventName: event.eventName,
    properties: event.properties,
  });
}

export function flushPendingEvents(): void {
  const eventsToSend = pendingEvents;
  pendingEvents = [];

  for (const event of eventsToSend) {
    capture(event.eventName, event.properties);
  }
}

export function discardPendingEvents(): void {
  pendingEvents = [];
}

export function aliasWebVisitor(webDistinctId?: string, distinctId = currentIdentity?.distinctId): void {
  if (!webDistinctId || !distinctId || webDistinctId === distinctId) return;

  try {
    posthog.alias(distinctId, webDistinctId);
  } catch (error) {
    console.error('[PostHog] Failed to alias web visitor:', error);
  }
}

export function aliasInstallIdentity(identity = currentIdentity): void {
  const installIdDistinctId = installDistinctId(identity);
  if (!installIdDistinctId || !identity?.distinctId) return;

  try {
    posthog.alias(identity.distinctId, installIdDistinctId);
  } catch (error) {
    console.error('[PostHog] Failed to alias install identity:', error);
  }
}

export async function aliasWebVisitorDirect(identity = currentIdentity): Promise<void> {
  if (!identity?.webDistinctId || identity.webDistinctId === identity.distinctId) return;

  await directCapture(
    '$create_alias',
    { alias: identity.distinctId },
    identity,
    {
      distinctId: identity.webDistinctId,
      processPersonProfile: true,
    }
  );
}

export async function aliasInstallIdentityDirect(identity = currentIdentity): Promise<void> {
  const installIdDistinctId = installDistinctId(identity);
  if (!installIdDistinctId || !identity?.distinctId) return;

  await directCapture(
    '$create_alias',
    { alias: identity.distinctId },
    identity,
    {
      distinctId: installIdDistinctId,
      processPersonProfile: true,
    }
  );
}

/**
 * Capture a single event and then opt out of capturing.
 *
 * Sends the event directly via HTTP instead of toggling the SDK's global
 * opt-in state, so no other events (autocapture, pageviews, etc.) can leak
 * during the flush window.
 */
export async function captureAndOptOut(
  eventName: string,
  properties?: AnalyticsProperties,
  identity = currentIdentity
): Promise<void> {
  currentIdentity = identity;
  await directCapture(eventName, properties, identity, {
    processPersonProfile: Boolean(identity),
  });
  posthog.opt_out_capturing();
  currentEnabled = false;
}

export function capture(eventName: string, properties?: AnalyticsProperties): void {
  try {
    posthog.capture(eventName, compactProperties({
      ...contextProperties(),
      ...properties,
    }));
  } catch (error) {
    console.error('[PostHog] Failed to capture event:', error);
  }
}

/**
 * Capture a single event directly, regardless of SDK opt-in state, without
 * toggling opt-in afterward. Counterpart to captureAndOptOut: that one is for
 * the decline click; this one is for deterministic consent/funnel markers.
 *
 * Sends the event directly via HTTP so it bypasses the SDK's opt-in gate.
 * Same network path as captureAndOptOut, just without the opt-out flip.
 *
 * Use this sparingly. The legitimate cases are funnel-completeness and
 * disclosure/choice events that must be captured in a strict order:
 * analytics_default_enabled, settings disclosure/explicit choices, and
 * app_first_opened.
 */
export async function captureUnconditionally(
  eventName: string,
  properties?: AnalyticsProperties,
  identity = currentIdentity
): Promise<void> {
  currentIdentity = identity;
  await directCapture(eventName, properties, identity, {
    processPersonProfile: Boolean(identity),
  });
}

export async function captureAppFirstOpened(identity = currentIdentity): Promise<void> {
  if (!identity?.isFirstLaunch && !identity?.webAttributionPresent) return;

  await captureUnconditionally('app_first_opened', {
    source: identity.webAttributionPresent ? 'web_attribution' : 'first_launch',
  }, identity);
}

export { posthog };
