# Security Policy

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion for a security
problem. Email the security contacts instead:

- Primary: khazapar7@gmail.com
- Also: tyler@tbrown.io

Send to both if you can. Please include:

- the Pane version and your OS;
- what an attacker controls (a repository's contents, a PR or issue, agent
  output, a network peer, a local process) and what they gain;
- the smallest steps or proof of concept that reproduce it;
- a candidate patch, if you have one.

We will reply by email and keep you updated until the problem is fixed.

## Supported versions

Fixes land on `main` and ship in the next release. Only the latest release of
the desktop app and the latest `runpane` packages on npm and PyPI get security
fixes; auto-update brings the app to it.

## Scope

[.oss-scanner/threat_model.md](.oss-scanner/threat_model.md) describes where
untrusted input enters Pane, what is in and out of scope, and how we rate
severity. In short: Pane itself (the Electron main process, its IPC, the
`runpane` CLI and its daemon connection, the remote web client, the phone apps
and the server they talk to, terminal handling, git and worktree operations,
and the update path) is in
scope. The coding agents Pane launches, and third-party dependencies, are not;
report those to their maintainers.
