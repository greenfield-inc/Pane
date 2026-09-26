import { boundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import type { RemoteMobilePushStatus } from '../../../../shared/types/remoteDaemon';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { VoiceTranscriptionChunk, VoiceTranscriptionResult } from '../../../../shared/types/voiceTranscription';
import { remoteBooleanSchema, remoteMessageSchema, remoteSessionSchema } from './remoteSessionSchemas';

const optionalString = boundary.optional(boundary.string);
const optionalNumber = boundary.optional(boundary.number);
const optionalBoolean = boundary.optional(boundary.boolean);
const nullableString = boundary.optional(boundary.nullable(boundary.string));
export const remotePanelSchema: BoundarySchema<ToolPanel> = boundary.object({
  id: boundary.nonEmptyString, sessionId: boundary.nonEmptyString,
  type: boundary.enumeration('terminal', 'diff', 'explorer', 'editor', 'logs', 'dashboard', 'setup-tasks', 'browser'),
  title: boundary.string,
  state: boundary.object({ isActive: boundary.boolean, isPinned: optionalBoolean, hasBeenViewed: optionalBoolean, customState: boundary.optional(boundary.jsonObject) }),
  metadata: boundary.object({ createdAt: boundary.string, lastActiveAt: boundary.string, position: boundary.number, permanent: optionalBoolean }),
});
export const remotePanelReferenceSchema = boundary.object({ sessionId: boundary.nonEmptyString, panelId: boundary.nonEmptyString });
export const remoteCreationFailureSchema = boundary.object({ name: boundary.string, error: boundary.string });
const projectSchema = boundary.object({
  id: boundary.number, name: boundary.string, path: boundary.string, active: remoteBooleanSchema,
  created_at: boundary.string, updated_at: boundary.string, system_prompt: nullableString, run_script: nullableString,
  build_script: nullableString, archive_script: nullableString, open_ide_command: nullableString, displayOrder: optionalNumber,
  worktree_folder: nullableString, lastUsedModel: optionalString, wsl_enabled: boundary.optional(remoteBooleanSchema), wsl_distribution: nullableString,
  environment: boundary.optional(boundary.enumeration('wsl', 'windows', 'linux', 'macos')),
  sessions: boundary.optional(boundary.array(remoteSessionSchema)),
});
const voiceMode = boundary.enumeration('recorded', 'streaming');
const modePresentation = boundary.object({ label: boundary.string, priceLabel: boundary.string, latencyLabel: boundary.string, recommended: boundary.boolean });
const affordancesSchema = boundary.object({
  terminalShortcuts: boundary.array(boundary.object({ id: boundary.string, label: boundary.string, key: boundary.string, text: boundary.string, enabled: boundary.boolean })),
  customCommands: boundary.array(boundary.object({ name: boundary.string, command: boundary.string })),
  voiceTranscription: boundary.object({
    availableModes: boundary.array(voiceMode), defaultMode: voiceMode,
    configured: boundary.object({ cleanup: boundary.boolean, recorded: boundary.boolean, streaming: boundary.boolean, fal: boundary.boolean, deepgram: boundary.boolean, openRouter: boundary.boolean }),
    modes: boundary.object({ streaming: modePresentation, recorded: modePresentation }),
  }),
});
const usageSchema = boundary.object({ cost: optionalNumber, costSource: boundary.optional(boundary.enumeration('provider', 'metadata', 'estimate', 'unavailable')), inputTokens: optionalNumber, outputTokens: optionalNumber, totalTokens: optionalNumber });
const chunkSchema: BoundarySchema<VoiceTranscriptionChunk> = {
  decode(cursor) {
    const chunk = boundary.object({ text: boundary.string, timestamp: boundary.optional(boundary.array(boundary.number)) }).decode(cursor);
    if (!chunk.timestamp) return { text: chunk.text };
    if (chunk.timestamp.length !== 2) return cursor.fail('expected two timestamp numbers');
    return { text: chunk.text, timestamp: [chunk.timestamp[0], chunk.timestamp[1]] };
  },
};
const transcriptionSchema: BoundarySchema<VoiceTranscriptionResult> = boundary.object({
  mode: voiceMode, provider: boundary.enumeration('fal-ai/wizper', 'deepgram/nova-3'), cleanupModel: boundary.literal('google/gemini-3.1-flash-lite'),
  text: boundary.string, rawText: boundary.string, chunks: boundary.optional(boundary.array(chunkSchema)), languages: boundary.optional(boundary.array(boundary.string)),
  timings: boundary.object({ asrMs: boundary.number, cleanupMs: boundary.number, totalMs: boundary.number, firstTranscriptMs: optionalNumber, falMs: optionalNumber }),
  providerUsage: boundary.optional(usageSchema), cleanupUsage: boundary.optional(usageSchema),
});
const pushStatusSchema: BoundarySchema<RemoteMobilePushStatus> = boundary.object({
  platform: boundary.enumeration('ios', 'android'), registration: boundary.enumeration('registered', 'not-registered', 'revoked'),
  provider: boundary.enumeration('ready', 'missing-config', 'invalid-config', 'unavailable'), code: boundary.string, message: boundary.string,
  needsInputEnabled: optionalBoolean, completedEnabled: optionalBoolean,
});
const acknowledgementSchema: BoundarySchema<void> = {
  decode(cursor) { boundary.optional(boundary.literal(null)).decode(cursor); },
};
const initializeSchema: BoundarySchema<void> = {
  decode(cursor) { boundary.literal(true).decode(cursor); },
};
export const remoteIpcEnvelopeSchema = boundary.object({ success: boundary.boolean, data: boundary.optional(boundary.json), error: optionalString });
export const remoteResponseSchemas = {
  'sessions:get-all-with-projects': boundary.array(projectSchema),
  'sessions:get': remoteSessionSchema,
  'panels:list': boundary.array(remotePanelSchema),
  'panels:getActive': boundary.nullable(remotePanelSchema),
  'panels:set-active': acknowledgementSchema,
  'remote:pwa-affordances': affordancesSchema,
  'voice:transcribe': transcriptionSchema,
  'voice:deepgram-token': boundary.object({ accessToken: boundary.nonEmptyString, expiresIn: boundary.number, expiresAt: boundary.number }),
  'voice:finalize-streaming': transcriptionSchema,
  'sessions:toggle-favorite': boundary.object({ isFavorite: boundary.boolean, favoritePinnedAt: nullableString }),
  'sessions:delete': acknowledgementSchema,
  'projects:list-branches': boundary.array(boundary.object({ name: boundary.string, isCurrent: boundary.boolean, hasWorktree: boundary.boolean, isRemote: boundary.boolean })),
  'projects:detect-branch': boundary.string,
  'sessions:create': boundary.union(boundary.object({ jobId: boundary.nonEmptyString }), boundary.object({ jobIds: boundary.array(boundary.nonEmptyString) })),
  'panels:create': remotePanelSchema,
  'panels:checkInitialized': boundary.boolean,
  'panels:initialize': initializeSchema,
  'panels:get-output': boundary.array(boundary.object({ sessionId: boundary.string, type: boundary.enumeration('stdout', 'stderr', 'json', 'error'), data: boundary.union(boundary.string, remoteMessageSchema), timestamp: boundary.string, panelId: optionalString })),
  'terminal:input': acknowledgementSchema, 'terminal:clearScrollback': acknowledgementSchema,
  'terminal:resize': acknowledgementSchema, 'terminal:setVisibility': acknowledgementSchema, 'terminal:ack': acknowledgementSchema,
  'mobile:push-revoke': boundary.object({ ok: boundary.literal(true) }), 'mobile:push-status': pushStatusSchema, 'mobile:push-controls': pushStatusSchema,
  'mobile:push-register': pushStatusSchema,
};
