import { describe, expect, it } from 'vitest';
import { GIT_CLONE_AUTH_REQUIRED } from '../../../shared/types/gitClone';
import { classifyGitCloneFailure, describeGitCloneFailure } from './gitCloneFailure';

const command = 'Command failed: git clone "https://github.com/jamari-morrison/montlakev2" "/home/user/montlakev2"\n';

// stderr as git 2.43 prints it on a fresh Ubuntu 24.04 host with no credentials (measured 2026-10-03).
const httpsNoCredentials = `${command}Cloning into '/home/user/montlakev2'...\nfatal: could not read Username for 'https://github.com': No such device or address\n`;
const sshUnknownHostKey = 'Command failed: git clone "git@github.com:jamari-morrison/montlakev2.git" "/home/user/montlakev2"\n'
  + "Cloning into '/home/user/montlakev2'...\nHost key verification failed.\r\nfatal: Could not read from remote repository.\n\n"
  + 'Please make sure you have the correct access rights\nand the repository exists.\n';
const sshNoKey = 'Command failed: git clone "git@github.com:jamari-morrison/montlakev2.git" "/home/user/montlakev2"\n'
  + "Cloning into '/home/user/montlakev2'...\ngit@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.\n\n"
  + 'Please make sure you have the correct access rights\nand the repository exists.\n';
const httpsBadToken = `${command}Cloning into '/home/user/montlakev2'...\nremote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/jamari-morrison/montlakev2/'\n`;
const httpsForbidden = `${command}Cloning into '/home/user/montlakev2'...\nremote: Permission to jamari-morrison/montlakev2.git denied to someone.\nfatal: unable to access 'https://github.com/jamari-morrison/montlakev2/': The requested URL returned error: 403\n`;
const notFound = `${command}Cloning into '/home/user/montlakev2'...\nremote: Repository not found.\nfatal: repository 'https://github.com/jamari-morrison/montlakev2/' not found\n`;
const offline = `${command}Cloning into '/home/user/montlakev2'...\nfatal: unable to access 'https://github.com/jamari-morrison/montlakev2/': Could not resolve host: github.com\n`;
const diskFull = `${command}Cloning into '/home/user/montlakev2'...\nfatal: write error: No space left on device\nfatal: fetch-pack: invalid index-pack output\n`;

describe('classifyGitCloneFailure', () => {
  it.each([
    ['HTTPS with no credentials', httpsNoCredentials, 'https-auth'],
    ['HTTPS with a rejected token', httpsBadToken, 'https-auth'],
    ['HTTPS refused with 403', httpsForbidden, 'https-forbidden'],
    ['SSH with an unknown host key', sshUnknownHostKey, 'ssh-host-key'],
    ['SSH with no accepted key', sshNoKey, 'ssh-publickey'],
    ['a missing repository', notFound, null],
    ['no network', offline, null],
    ['a full disk', diskFull, null],
    ['an empty message', '', null],
  ])('classifies %s', (_case, message, expected) => {
    expect(classifyGitCloneFailure(message)).toBe(expected);
  });
});

describe('describeGitCloneFailure', () => {
  it('keeps the existing message for HTTPS sign-in failures and marks them', () => {
    const expected = { error: 'Authentication failed — check your credentials or use an SSH URL.', code: GIT_CLONE_AUTH_REQUIRED };
    expect(describeGitCloneFailure(httpsNoCredentials)).toEqual(expected);
    expect(describeGitCloneFailure(httpsBadToken)).toEqual(expected);
  });

  it('keeps git\'s own text for a 403 and marks it', () => {
    expect(describeGitCloneFailure(httpsForbidden)).toEqual({ error: httpsForbidden, code: GIT_CLONE_AUTH_REQUIRED });
  });

  it('explains SSH failures instead of showing the raw command output', () => {
    expect(describeGitCloneFailure(sshUnknownHostKey)).toEqual({
      error: "SSH host key verification failed — this computer doesn't trust the Git server yet. Connect to it once with ssh to accept its host key, or use an HTTPS URL.",
      code: GIT_CLONE_AUTH_REQUIRED,
    });
    expect(describeGitCloneFailure(sshNoKey)).toEqual({
      error: 'SSH authentication failed — the Git server rejected this computer\'s SSH key. Add your SSH key to your Git host, or use an HTTPS URL.',
      code: GIT_CLONE_AUTH_REQUIRED,
    });
  });

  it('keeps the existing messages for failures that are not about signing in', () => {
    expect(describeGitCloneFailure(notFound)).toEqual({ error: 'Repository not found — check the URL and try again.' });
    expect(describeGitCloneFailure(offline)).toEqual({ error: 'Network error — check your internet connection and try again.' });
    expect(describeGitCloneFailure(diskFull)).toEqual({ error: diskFull });
  });
});
