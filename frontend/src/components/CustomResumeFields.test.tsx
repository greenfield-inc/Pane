import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CustomResumeFields } from './CustomResumeFields';
import type { CustomCommandResume } from '../../../shared/types/customCommandResume';

const AGENT_FARM_NOTE = 'Agent Farm commands resume automatically';
const explicit: CustomCommandResume = {
  mode: 'reported',
  initialTemplate: '{command}',
  resumeTemplate: '{command} --resume {sessionId}',
};

function render(command: string | undefined, value: CustomCommandResume | null = null) {
  return renderToStaticMarkup(<CustomResumeFields command={command} value={value} onChange={() => undefined} />);
}

describe('CustomResumeFields', () => {
  it('explains automatic resume for a recognized Agent Farm command with no explicit config', () => {
    expect(render('agent-farm run greenfield/implementer')).toContain(AGENT_FARM_NOTE);
  });

  it('says nothing about Agent Farm for other wrappers', () => {
    expect(render('my-wrapper run')).not.toContain(AGENT_FARM_NOTE);
    expect(render(undefined)).not.toContain(AGENT_FARM_NOTE);
  });

  it('says nothing when the command already passes its own --resume', () => {
    expect(render('agent-farm run P --resume x')).not.toContain(AGENT_FARM_NOTE);
  });

  it('says nothing once an explicit resume config is set', () => {
    expect(render('agent-farm run greenfield/implementer', explicit)).not.toContain(AGENT_FARM_NOTE);
  });
});
