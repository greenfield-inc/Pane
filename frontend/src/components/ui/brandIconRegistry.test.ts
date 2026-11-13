import { describe, expect, it } from 'vitest';
import { getCliBrandIcon } from './brandIconRegistry';
import { ClaudeIcon, OpenCodeIcon, PiIcon } from './BrandIcons';

describe('getCliBrandIcon', () => {
  it.each(['Pi', 'pi', 'pi --session-id 0b6a3f0e-8d1c-4f6e-9a57-3d2c1b0a9f8e', '/opt/homebrew/bin/pi', 'C:\\npm\\pi.cmd'])('shows the Pi icon for %j', (name) => {
    expect(getCliBrandIcon(name)?.type).toBe(PiIcon);
  });

  it.each(['api server', 'pip install -e .', 'ssh pi@raspberrypi.local', 'Spinner demo', 'npm run typing'])('does not show the Pi icon for %j', (name) => {
    expect(getCliBrandIcon(name)?.type).not.toBe(PiIcon);
  });

  it('keeps substring matching for the other agents', () => {
    expect(getCliBrandIcon('Claude Code')?.type).toBe(ClaudeIcon);
    expect(getCliBrandIcon('my opencode tab')?.type).toBe(OpenCodeIcon);
    expect(getCliBrandIcon('api server')).toBeNull();
  });
});
