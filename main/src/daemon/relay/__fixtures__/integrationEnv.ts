/**
 * Whether an integration suite's binaries are set, so it runs; otherwise it is skipped. CI's Relay
 * Tests job sets them all and PANE_RELAY_INTEGRATION_REQUIRED=1, so there a missing one fails the
 * suite instead of dropping its coverage. The other CI jobs run the unit tests without them.
 */
export function integrationEnvSet(names: readonly string[]): boolean {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length && process.env.PANE_RELAY_INTEGRATION_REQUIRED === '1') {
    throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set, so this integration suite cannot run in the Relay Tests job. Set ${missing.length === 1 ? 'it' : 'them'} in .github/workflows/quality.yml.`);
  }
  return missing.length === 0;
}
