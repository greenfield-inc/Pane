import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrowserDataSetting } from './BrowserDataSetting';
import { clearBrowserData } from '../clearBrowserData';
import { SETTINGS_CATEGORIES, settingDomId } from '../catalog';

// Clicking through the confirmation belongs to tests/browser-auth-persistence.spec.ts;
// this suite has no DOM environment to dispatch events in.
describe('Clear browser data', () => {
  it('renders the Browser data row under Privacy with its explanation and button', () => {
    const markup = renderToStaticMarkup(<BrowserDataSetting />);

    expect(markup).toContain(`id="${settingDomId('browser-data')}"`);
    expect(markup).toContain('Browser data');
    expect(markup).toContain("Pane&#x27;s browser keeps one set of logins, cookies and site data for every project and Session.");
    expect(markup).toContain('Clear browser data');
    const privacy = SETTINGS_CATEGORIES.find((category) => category.id === 'privacy');
    expect(privacy?.settingIds).toContain('browser-data');
  });

  it('reports success once main has cleared everything', async () => {
    const invoke = vi.fn(() => Promise.resolve());

    await expect(clearBrowserData(invoke)).resolves.toEqual({
      kind: 'success',
      message: "Browser data cleared. You're signed out of every site in Pane's browser.",
    });
    expect(invoke).toHaveBeenCalledWith('browser-data:clear');
  });

  it('shows main\'s reason, without the IPC wrapper, and no success when an old store stays behind', async () => {
    const invoke = vi.fn(() => Promise.reject(new Error(
      "Error invoking remote method 'browser-data:clear': Error: Pane cleared your logins but couldn't remove some older browser data at /profile/Partitions/project-3: EBUSY. Next: Close any open browser tabs and run Clear browser data again.",
    )));

    await expect(clearBrowserData(invoke)).resolves.toEqual({
      kind: 'failure',
      message: "Pane cleared your logins but couldn't remove some older browser data at /profile/Partitions/project-3: EBUSY. Next: Close any open browser tabs and run Clear browser data again.",
    });
  });
});
