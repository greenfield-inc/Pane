import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CloneSignInNotice } from './CloneSignInNotice';
import type { GitHubDeviceLoginState } from '../../../shared/types/githubDeviceLogin';

function render(deviceLogin: GitHubDeviceLoginState, options: { overSsh?: boolean; deviceLoginError?: string; managedInSettings?: boolean } = {}) {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <CloneSignInNotice
      host="devbox"
      overSsh={options.overSsh ?? false}
      managedInSettings={options.managedInSettings ?? false}
      onOpenSettings={noop}
      retrying={false}
      deviceLogin={deviceLogin}
      deviceLoginError={options.deviceLoginError ?? ''}
      onSignIn={noop}
      onCancelSignIn={noop}
      onOpenTerminal={noop}
      onTryAgain={noop}
    />,
  );
}

const HEADLINE = 'devbox isn&#x27;t signed in to GitHub.';
const DEVICE_HINT = 'Open github.com/login/device on your computer, enter the code, and wait here.';

describe('CloneSignInNotice', () => {
  it('offers signing in from Pane first, with the terminal as a fallback', () => {
    const markup = render({ status: 'idle' });
    expect(markup).toContain(HEADLINE);
    expect(markup).toContain('Sign in on devbox, then try again.');
    expect(markup.indexOf('Sign in to GitHub<')).toBeLessThan(markup.indexOf('Open terminal on devbox to sign in'));
    expect(markup).toContain('Try again');
    expect(markup).toContain(DEVICE_HINT);
  });

  it('shows the code, Copy, the device page and Cancel while waiting', () => {
    const markup = render({ status: 'waiting', loginId: 'a', code: 'fake-0000', verificationUrl: 'https://github.com/login/device' });
    expect(markup).toContain('>fake-0000<');
    // Screenshot and video kits mask the code by this name and marker.
    expect(markup).toContain('aria-label="One-time code" data-secret="github-device-code"');
    expect(markup).toContain('>Copy<');
    expect(markup).toContain('Open github.com/login/device');
    expect(markup).toContain('Waiting for you to approve on GitHub…');
    expect(markup).toContain('>Cancel<');
    expect(markup).not.toContain('Sign in to GitHub<');
  });

  it('says who is signed in and offers Try again', () => {
    const markup = render({ status: 'signed-in', loginId: 'a', user: 'octocat' });
    expect(markup).toContain('Signed in to GitHub as octocat');
    expect(markup).toContain('Try again');
    expect(markup).not.toContain(HEADLINE);
    expect(markup).not.toContain('fake-0000');
  });

  it('shows a failure with the terminal fallback and lets the user start again', () => {
    const markup = render({ status: 'failed', loginId: 'a', reason: 'expired', exitCode: 1, message: 'The code expired before it was approved. Start again.' });
    expect(markup).toContain('The code expired before it was approved. Start again.');
    expect(markup).toContain('Open terminal on devbox to sign in');
    expect(markup).toContain('Sign in to GitHub<');
  });

  it('shows why sign-in could not start', () => {
    expect(render({ status: 'idle' }, { deviceLoginError: 'Could not start signing in to GitHub.' }))
      .toContain('Could not start signing in to GitHub.');
  });

  it('keeps the SSH line for SSH URLs only', () => {
    const line = 'This is an SSH URL; after signing in, use the HTTPS URL instead.';
    expect(render({ status: 'idle' }, { overSsh: true })).toContain(line);
    expect(render({ status: 'idle' })).not.toContain(line);
  });

  it('sends a host whose GitHub sign-in lives in Settings there instead', () => {
    const markup = render({ status: 'idle' }, { managedInSettings: true });
    expect(markup).toContain('>Add a GitHub token in Settings<');
    expect(markup).toContain('>Open Settings<');
    expect(markup).toContain('Try again');
    expect(markup).not.toContain(HEADLINE);
    expect(markup).not.toContain('Sign in to GitHub<');
    expect(markup).not.toContain('Open terminal on devbox');
    expect(markup).not.toContain(DEVICE_HINT);
  });

  it('keeps the SSH line on the Settings route', () => {
    expect(render({ status: 'idle' }, { managedInSettings: true, overSsh: true }))
      .toContain('This is an SSH URL; after signing in, use the HTTPS URL instead.');
  });
});
