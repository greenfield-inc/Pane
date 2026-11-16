import type { DeviceOpenMarker, DevicePanelPhase } from './types/devices';
import type { ToolPanel } from './types/panels';
import { boundary, decodeOptionalBoundary } from './validation/boundaryDecoder';

const resultSchema = boundary.object({
  paneDevice: boundary.object({
    kind: boundary.literal('pane-device'),
    panelId: boundary.string,
    name: boundary.string,
    os: boundary.optional(boundary.string),
    machine: boundary.string,
  }),
});

const phaseSchema = boundary.object({ phase: boundary.enumeration('installing', 'booting', 'live', 'off', 'in-use', 'closed', 'no-mac', 'mac-offline', 'error') });

function markerIn(text: string): DeviceOpenMarker | undefined {
  let result;
  try {
    result = decodeOptionalBoundary(JSON.parse(text), resultSchema);
  } catch {
    return undefined;
  }
  if (!result) return undefined;
  const { os, ...marker } = result.paneDevice;
  return os === undefined ? marker : { ...marker, os };
}

/**
 * The device marker in a device_open step's result text, so a chat tab can show its card.
 * Recognised by the result itself, since tool titles differ between agents. Some agents wrap the
 * result's JSON in other text, so the outermost braces are tried too.
 */
export function deviceMarkerOf(output: string | undefined): DeviceOpenMarker | undefined {
  if (!output?.includes('pane-device')) return undefined;
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  const texts = [output, ...(start !== -1 && end > start ? [output.slice(start, end + 1)] : [])];
  for (const text of texts) {
    const marker = markerIn(text);
    if (marker) return marker;
  }
  return undefined;
}

/** The phase of the device tab `panelId` among a Pane's tabs, or undefined when it is not there. */
export function devicePhaseOf(panels: readonly ToolPanel[], panelId: string): DevicePanelPhase | undefined {
  const panel = panels.find(candidate => candidate.id === panelId && candidate.type === 'device');
  return decodeOptionalBoundary(panel?.state.customState, phaseSchema)?.phase;
}
