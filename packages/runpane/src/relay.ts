import { createRequire } from 'node:module';
import path from 'node:path';
import { RunpaneError } from './errors';
import { runForwardingSignals } from './forwardedChild';

/**
 * `runpane relay [pane-relay flags...]`: runs this platform's prebuilt `pane-relay`, which npm
 * installs as runpane's optional dependency `@runpane/relay-<platform>-<arch>`
 * (scripts/runpane-relay-packages.js builds them). Flags, stdio, signals and the exit code pass
 * through unchanged.
 */
export async function runRelay(args: string[]): Promise<number> {
  const binary = relayBinary();
  const ended = await runForwardingSignals(binary, args);
  if ('error' in ended) {
    throw new RunpaneError(
      'ERR_RELAY_START_FAILED',
      `runpane relay could not start ${binary} (${ended.error}). Nothing was started.`,
      'Reinstall runpane so npm writes the relay binary again: npm install -g runpane@latest, or run npx --yes runpane@latest relay.',
    );
  }
  if (ended.signal) process.kill(process.pid, ended.signal);
  return ended.status ?? 1;
}

function relayBinary(): string {
  const name = `@runpane/relay-${process.platform}-${process.arch}`;
  let manifest: string;
  try {
    manifest = createRequire(__filename).resolve(`${name}/package.json`);
  } catch {
    throw new RunpaneError(
      'ERR_RELAY_NOT_INSTALLED',
      `runpane relay found no pane-relay for ${process.platform} ${process.arch}: its package ${name} is not installed beside this runpane. Nothing was started.`,
      'Run npx --yes runpane@latest relay <flags>: npm installs the binary on macOS, Linux and Windows (x64 and arm64) unless optional dependencies are turned off; '
        + 'Pane\'s built-in runpane has none. On other platforms, build pane-relay from relay/ or use its container: https://github.com/greenfield-inc/Pane/blob/main/docs/SELF_HOSTED_RELAY.md',
    );
  }
  return path.join(path.dirname(manifest), 'bin', process.platform === 'win32' ? 'pane-relay.exe' : 'pane-relay');
}
