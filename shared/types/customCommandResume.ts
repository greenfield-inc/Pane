import { boundary, decodeBoundary } from '../validation/boundaryDecoder';

export interface CustomCommandResume {
  mode: 'claude' | 'codex' | 'cursor' | 'generated' | 'reported';
  initialTemplate: string;
  resumeTemplate: string;
}

export const customCommandResumeSchema = boundary.object({
  mode: boundary.enumeration('claude', 'codex', 'cursor', 'generated', 'reported'),
  initialTemplate: boundary.string,
  resumeTemplate: boundary.nonEmptyString,
});

export function validateCustomCommandResume(value: CustomCommandResume): CustomCommandResume {
  const config = decodeBoundary(value, customCommandResumeSchema);
  if (!config.resumeTemplate.includes('{sessionId}')) throw new Error('Resume command must contain {sessionId}');
  if ((config.mode === 'generated' || config.mode === 'claude') && !config.initialTemplate.includes('{sessionId}')) {
    throw new Error('First launch command must contain {sessionId} for allocated IDs');
  }
  if (config.initialTemplate.length > 10000 || config.resumeTemplate.length > 10000) throw new Error('Resume command is too long');
  return config;
}

export function customResumeAgentType(config?: CustomCommandResume | null): 'claude' | 'codex' | 'cursor' | undefined {
  const mode = config?.mode;
  return mode === 'claude' || mode === 'codex' || mode === 'cursor' ? mode : undefined;
}
