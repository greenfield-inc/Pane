import { RUNPANE_CONTRACT } from './generated/contract';
import { RunpaneError } from './errors';

export function assertSupportedCliRuntime(node: string, electron?: string): void {
  // Pane's managed shim uses ELECTRON_RUN_AS_NODE. Electron 43.8.3 embeds
  // Node 24.22.0 with its own CA backport: actual embedded Node and Chromium
  // TLS probes reject both incident chains. This allowance is deliberately
  // limited to that audited pair; it does not admit standalone Node 24.22.0.
  if (electron === '43.8.3' && node === '24.22.0') return;
  assertSupportedNodeRuntime(node);
}

/** The contract lists caret ranges for supported stable Node majors only. */
export function assertSupportedNodeRuntime(version: string): void {
  const actual = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const supported = actual && RUNPANE_CONTRACT.compatibility.node.split(' || ').some(range => {
    const floor = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
    return floor && Number(actual[1]) === Number(floor[1]) && (
      Number(actual[2]) > Number(floor[2]) ||
      (Number(actual[2]) === Number(floor[2]) && Number(actual[3]) >= Number(floor[3]))
    );
  });
  if (!supported) {
    throw new RunpaneError(
      'ERR_NODE_RUNTIME',
      `Node ${version} is outside runpane's patched supported runtimes. No command was run.`,
      `Install standalone Node matching ${RUNPANE_CONTRACT.compatibility.node}, then retry.`,
    );
  }
}
