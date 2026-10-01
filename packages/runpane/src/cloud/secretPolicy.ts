/**
 * Which secret names may reach a cloud Session: shared by the laptop's `cloud secrets set` and the
 * coordinator's Doppler secrets service. No imports: the coordinator bundles it.
 */

/**
 * Names that never enter a sandbox by default: production, infrastructure and admin credentials,
 * and secret-manager tokens. `*` matches any run of characters; matching ignores case. The laptop
 * extends it with `secretsDenyList`; a coordinator's secrets policy may replace it (the user's call).
 */
export const BUILT_IN_DENY_LIST: readonly string[] = [
  'PRODUCTION_*',
  'CLOUDFLARE_*',
  'SHOPIFY_ADMIN*',
  'VERCEL_*',
  'NEON_*',
  'DOPPLER_TOKEN',
  'DOPPLER_*',
  '*_MANAGEMENT_*',
];

/** Variables the shell or Pane itself owns; a secret must never override them. Not configurable. */
const RESERVED_NAMES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'IFS', 'TERM', 'LANG', 'ENV', 'BASH_ENV', 'PROMPT_COMMAND', 'PS1', 'PS2', 'PS4', 'LD_*', 'PANE_*', 'WORKTREE_PATH', 'RUNPANE_*'];

/** Doppler configs that hold staging or production values, refused by default (and their branch configs). */
export const DENIED_DOPPLER_CONFIGS: readonly string[] = ['prd', 'prod', 'stg', 'stage', 'staging', 'production'];

export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function globToRegExp(pattern: string): RegExp {
  const body = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 'iu');
}

/** The first pattern in `patterns` that matches `name` (ignoring case), or null. */
export function matchingPattern(name: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    if (globToRegExp(pattern.trim()).test(name)) return pattern;
  }
  return null;
}

/** The reserved shell or Pane name pattern that `name` matches, or null. */
export function reservedBy(name: string): string | null {
  return matchingPattern(name, RESERVED_NAMES);
}

/** Whether `config` (or the root it branches from, `dev_x` -> `dev`) is in `denied`. */
export function isDeniedConfig(config: string, denied: readonly string[]): boolean {
  const lower = config.toLowerCase();
  const root = lower.split(/[_-]/u)[0];
  const set = denied.map((value) => value.toLowerCase());
  return set.includes(lower) || set.includes(root);
}
