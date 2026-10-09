import { useEffect } from 'react';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { ImmediateToggle } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import {
  aliasInstallIdentity,
  aliasInstallIdentityDirect,
  aliasWebVisitor,
  aliasWebVisitorDirect,
  captureAndOptOut,
  captureUnconditionally,
  discardPendingEvents,
  flushPendingEvents,
  initPostHog,
} from '../../../services/posthog';
import type { AnalyticsIdentity } from '../../../types/config';

export function PrivacySettings({ persistence }: { persistence: SettingsPersistence }) {
  const config = persistence.config!;
  const analytics = config.analytics ?? { enabled: true };

  useEffect(() => {
    if (analytics.enabled) {
      void captureUnconditionally('analytics_settings_disclosure_viewed', { experiment: 'analytics_default_on' });
    }
  }, [analytics.enabled]);

  const resolveIdentity = async (): Promise<AnalyticsIdentity | undefined> => {
    try {
      const response = await window.electronAPI?.analytics?.getIdentity?.();
      return response?.success ? response.data : undefined;
    } catch {
      return undefined;
    }
  };

  const syncAnalytics = async (enabled: boolean, identity?: AnalyticsIdentity) => {
    initPostHog({
      enabled,
      posthogApiKey: analytics.posthogApiKey,
      posthogHost: analytics.posthogHost,
      identity,
    }, { flushPendingEvents: false });
    if (enabled) {
      aliasInstallIdentity(identity);
      if (identity?.webDistinctId) {
        aliasWebVisitor(identity.webDistinctId, identity.distinctId);
        void window.electronAPI?.analytics?.redeemAttribution?.();
      }
      await captureUnconditionally('analytics_opted_in', undefined, identity);
      flushPendingEvents();
      return;
    }
    await aliasInstallIdentityDirect(identity);
    if (identity?.webDistinctId) {
      await aliasWebVisitorDirect(identity);
      void window.electronAPI?.analytics?.redeemAttribution?.();
    }
    await captureAndOptOut('analytics_opted_out', undefined, identity);
    discardPendingEvents();
  };

  const saveAnalytics = async (enabled: boolean): Promise<boolean> => {
    const saved = await persistence.saveConfig('analytics', { analytics: { ...analytics, enabled } });
    if (!saved) return false;
    try {
      await syncAnalytics(enabled, await resolveIdentity());
      return true;
    } catch (error) {
      persistence.reportSaveError('analytics', error instanceof Error ? error.message : 'Analytics preference saved, but runtime sync failed');
      return true;
    }
  };

  return (
    <SettingsPage title="Privacy" description="Review and control what Pane shares.">
      <SettingsSection title="Analytics">
        <SettingRow
          settingId="analytics"
          label="Product analytics"
          description="Product analytics are on by default. Pane collects feature usage and may associate it with locally available GitHub or Git account details, such as a username or email. App error reports contain coarse error details and relative app stack locations. Pane never collects prompts, code, or repository paths. Turn this off to stop telemetry."
          saveState={persistence.saveStates.analytics}
        >
          <ImmediateToggle label="Allow product analytics" value={analytics.enabled === true} onSave={saveAnalytics} />
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
