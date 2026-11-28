import { describe, expect, it } from 'vitest';
import { notificationIconUrl } from './notificationIcon';

describe('notificationIconUrl', () => {
  it('resolves next to the page on the dev server', () => {
    expect(notificationIconUrl('http://localhost:4521/')).toBe('http://localhost:4521/favicon-96x96.png');
  });

  it('resolves inside the packaged app on macOS and Linux', () => {
    expect(notificationIconUrl('file:///Applications/Pane.app/Contents/Resources/app.asar/frontend/dist/index.html'))
      .toBe('file:///Applications/Pane.app/Contents/Resources/app.asar/frontend/dist/favicon-96x96.png');
  });

  it('resolves inside the packaged app on Windows', () => {
    expect(notificationIconUrl('file:///C:/Program%20Files/Pane/resources/app.asar/frontend/dist/index.html'))
      .toBe('file:///C:/Program%20Files/Pane/resources/app.asar/frontend/dist/favicon-96x96.png');
  });

  it('never points at the root of the disk', () => {
    expect(notificationIconUrl('file:///opt/Pane/resources/app.asar/frontend/dist/index.html')).not.toBe('file:///favicon-96x96.png');
  });
});
