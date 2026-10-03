import { boundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import { customCommandResumeSchema } from '../../../../shared/types/customCommandResume';
import type { OrchestrationActivity, OrchestrationAssociation, OrchestrationLink, OrchestrationReport, OrchestrationSessionRecord } from '../../../../shared/types/orchestrationSession';
const paneChatAgentSchema = boundary.enumeration('claude', 'codex', 'cursor');
const sourceSchema = boundary.enumeration('user', 'agent', 'system');
const activityKindSchema = boundary.enumeration(
  'created',
  'updated',
  'associated',
  'detached',
  'working',
  'blocked',
  'idle',
  'unknown',
  'report',
);
const linkKindSchema = boundary.enumeration('evidence', 'output', 'ticket', 'pull-request', 'other');

const linkSchema: BoundarySchema<OrchestrationLink> = boundary.object({
  label: boundary.nonEmptyString,
  url: boundary.nonEmptyString,
  kind: boundary.optional(linkKindSchema),
  provenance: boundary.optional(boundary.string),
  addedAt: boundary.nonEmptyString,
});

const reportSchema: BoundarySchema<OrchestrationReport> = boundary.object({
  summary: boundary.nonEmptyString,
  status: boundary.enumeration('reported', 'verified'),
  evidence: boundary.array(linkSchema),
  reportedAt: boundary.nonEmptyString,
  provenance: boundary.nonEmptyString,
});

const associationSchema: BoundarySchema<OrchestrationAssociation> = boundary.object({
  paneId: boundary.nonEmptyString,
  panelIds: boundary.array(boundary.nonEmptyString),
  attachedAt: boundary.nonEmptyString,
});

const activitySchema: BoundarySchema<OrchestrationActivity> = boundary.object({
  id: boundary.nonEmptyString,
  kind: activityKindSchema,
  message: boundary.string,
  at: boundary.nonEmptyString,
  source: sourceSchema,
  paneId: boundary.optional(boundary.nonEmptyString),
  panelId: boundary.optional(boundary.nonEmptyString),
});

const sessionSchema: BoundarySchema<OrchestrationSessionRecord> = boundary.object({
  runtime: boundary.optional(boundary.enumeration('windows', 'wsl')),
  wslDistribution: boundary.optional(boundary.nonEmptyString),
  promotedFrom: boundary.optional(boundary.object({ paneId: boundary.nonEmptyString, panelId: boundary.nonEmptyString })),
  id: boundary.nonEmptyString,
  name: boundary.nonEmptyString,
  archived: boundary.optional(boundary.boolean),
  isPinned: boundary.optional(boundary.boolean),
  agent: paneChatAgentSchema,
  launchCommand: boundary.optional(boundary.string),
  customResume: boundary.optional(boundary.nullable(customCommandResumeSchema)),
  profile: boundary.optional(boundary.string),
  internalSessionId: boundary.nonEmptyString,
  panelIds: boundary.object({
    claude: boundary.nonEmptyString,
    codex: boundary.nonEmptyString,
    cursor: boundary.nonEmptyString,
  }),
  goal: boundary.string,
  context: boundary.string,
  decisions: boundary.array(boundary.string),
  blockers: boundary.array(boundary.string),
  nextAction: boundary.string,
  evidence: boundary.array(linkSchema),
  outputs: boundary.array(linkSchema),
  associations: boundary.array(associationSchema),
  activity: boundary.array(activitySchema),
  report: boundary.optional(reportSchema),
  reportActivityId: boundary.optional(boundary.nonEmptyString),
  reportAcceptedAt: boundary.optional(boundary.nonEmptyString),
  revision: boundary.number,
  createdAt: boundary.nonEmptyString,
  updatedAt: boundary.nonEmptyString,
});


export const remoteOrchestrationSessionSchema = sessionSchema;
export const remoteOrchestrationListSchema = boundary.object({ sessions: boundary.array(sessionSchema), selectedSessionId: boundary.optional(boundary.string) });
