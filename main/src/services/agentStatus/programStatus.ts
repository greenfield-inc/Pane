/**
 * Program Status Protocol (OSC 7501): a program prints
 * `ESC ] 7501 ; state=working:app=cargo:msg=<base64> ST` to say it is idle,
 * working, blocked, done or failed. Spec, revision 0.4:
 * https://www.superlogical.com/rex/docs/build/program-status
 *
 * One ProgramStatusRecords belongs to one terminal, so a program can only
 * ever change the status of the tab it prints in.
 */

import type { AgentDetectionResult } from '../../../../shared/types/agentStatus';

type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error';
type ProgramBlockedKind = 'permission' | 'question' | 'auth';

/** The record a terminal shows: its most urgent one. */
export interface ProgramStatus {
  state: ProgramState;
  kind?: ProgramBlockedKind;
  app?: string;
  title?: string;
  msg?: string;
}

const PROGRAM_STATUS_REASON = 'program_status';

/** The status event's reason says a program reported this state itself. */
export function isProgramStatusReason(reason: string | null | undefined): boolean {
  return reason?.startsWith(`${PROGRAM_STATUS_REASON}:`) ?? false;
}

/**
 * A reported record as a detection result: blocked needs the person, working
 * is working, and idle, done and error are all at rest (the renderer shows an
 * unseen finish as done). The rule id names the state and kind.
 */
export function detectionFromProgramStatus(status: ProgramStatus): AgentDetectionResult {
  const state = status.state === 'blocked' || status.state === 'working' ? status.state : 'idle';
  return {
    state,
    visibleBlocker: state === 'blocked',
    visibleWorking: state === 'working',
    visibleIdle: state === 'idle',
    skipStateUpdate: false,
    matchedRuleId: [PROGRAM_STATUS_REASON, status.state, status.kind].filter(Boolean).join(':'),
    reported: true,
  };
}

/** What a terminal answers to the feature-detection query `OSC 7501 ; ? ST`. */
export const PROGRAM_STATUS_QUERY_REPLY = '\x1b]7501;?\x1b\\';

const STATES = new Map<string, ProgramState | 'clear'>(
  (['idle', 'working', 'done', 'blocked', 'error', 'clear'] as const).map(state => [state, state]),
);
const KINDS = new Map<string, ProgramBlockedKind>((['permission', 'question', 'auth'] as const).map(kind => [kind, kind]));
// Most urgent first: what needs the person, then what is running, then results.
const URGENCY: readonly ProgramState[] = ['blocked', 'working', 'error', 'done', 'idle'];

const KEY = /^[a-z]+$/;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const APP = /^[A-Za-z0-9_.+-]{1,32}$/;
const ID_SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// Direction overrides and invisible formatting are removed before showing text.
const INVISIBLE_FORMATTING = /[​-‏‪-‮⁠-⁩﻿]/gu;

// Limits. A whole sequence is at most 4096 bytes: `ESC ] 7501 ;` and `ESC \` take 9.
const MAX_BODY = 4096 - 9;
const MAX_KEY = 16;
const MAX_ID = 128;
const MAX_ID_DEPTH = 8;
const MAX_RECORDS = 256;
const TEXT_LIMITS = { msg: { encoded: 2732, decoded: 2048 }, title: { encoded: 256, decoded: 192 } } as const;

const utf8 = new TextDecoder('utf-8', { fatal: true });

interface StoredRecord {
  state: ProgramState;
  kind?: ProgramBlockedKind;
  app?: string;
  title?: string;
  msg?: string;
}

/** Standard base64 of UTF-8 text with no control characters, or undefined. */
function decodeText(value: string, limit: { encoded: number; decoded: number }): string | undefined {
  if (value.length > limit.encoded || !BASE64.test(value) || value.replace(/=+$/, '').length % 4 === 1) return undefined;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > limit.decoded) return undefined;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return undefined;
  }
  return hasControlCharacter(text) ? undefined : text;
}

/** C0, DEL and C1 controls make a report invalid. */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function validId(id: string): boolean {
  if (id.length > MAX_ID) return false;
  const segments = id.split('/');
  return segments.length <= MAX_ID_DEPTH && segments.every(segment => ID_SEGMENT.test(segment));
}

function parentOf(id: string): string | undefined {
  if (id === '') return undefined;
  const slash = id.lastIndexOf('/');
  return slash === -1 ? '' : id.slice(0, slash);
}

export class ProgramStatusRecords {
  // Keyed by id ('' is the root record); insertion order is update order.
  private readonly records = new Map<string, StoredRecord>();

  /**
   * Apply one report body, the text between `OSC 7501 ;` and ST. Malformed or
   * over-limit reports change nothing. Returns whether any record changed.
   */
  report(body: string): boolean {
    if (body.length > MAX_BODY) return false;
    const pairs = new Map<string, string>();
    for (const pair of body.split(':')) {
      const equals = pair.indexOf('=');
      if (equals === -1) continue;
      const key = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      if (key.length > MAX_KEY) return false;
      if (!KEY.test(key) || !VALUE.test(value)) continue;
      pairs.set(key, value);
    }

    const state = STATES.get(pairs.get('state') ?? '');
    if (!state) return false;
    const id = pairs.get('id') ?? '';
    if (pairs.has('id') && !validId(id)) return false;

    if (state === 'clear') return this.clear(pairs.has('id') ? id : undefined);

    const record: StoredRecord = { state };
    const kind = KINDS.get(pairs.get('kind') ?? '');
    if (state === 'blocked' && kind) record.kind = kind;
    const app = pairs.get('app');
    if (app !== undefined && app.length > 32) return false;
    if (app && APP.test(app)) record.app = app;
    for (const key of ['title', 'msg'] as const) {
      const value = pairs.get(key);
      if (value === undefined) continue;
      if (value.length > TEXT_LIMITS[key].encoded) return false;
      const text = decodeText(value, TEXT_LIMITS[key]);
      if (text === undefined) return false;
      record[key] = text;
    }

    this.records.delete(id);
    this.records.set(id, record);
    if (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }
    return true;
  }

  /** The process exited or a new shell prompt began: running records end, results stay. */
  dropRunning(): boolean {
    return this.dropWhere(record => record.state !== 'done' && record.state !== 'error');
  }

  /** The person came back to the terminal: results have been seen. */
  dropFinished(): boolean {
    return this.dropWhere(record => record.state === 'done' || record.state === 'error');
  }

  /** Full reset (RIS) removes every record. */
  reset(): boolean {
    return this.clear(undefined);
  }

  /** The most urgent record, latest first within a state, or undefined when there is none. */
  current(): ProgramStatus | undefined {
    let winner: [string, StoredRecord] | undefined;
    for (const entry of this.records) {
      if (!winner || URGENCY.indexOf(entry[1].state) <= URGENCY.indexOf(winner[1].state)) winner = entry;
    }
    if (!winner) return undefined;
    const [id, record] = winner;
    const status: ProgramStatus = { state: record.state };
    if (record.kind) status.kind = record.kind;
    const app = record.app ?? this.inheritedApp(id);
    if (app) status.app = app;
    if (record.title) status.title = record.title.replace(INVISIBLE_FORMATTING, '');
    if (record.msg) status.msg = record.msg.replace(INVISIBLE_FORMATTING, '');
    return status;
  }

  private inheritedApp(id: string): string | undefined {
    for (let parent = parentOf(id); parent !== undefined; parent = parentOf(parent)) {
      const app = this.records.get(parent)?.app;
      if (app) return app;
    }
    return undefined;
  }

  private clear(id: string | undefined): boolean {
    if (id === undefined) {
      const had = this.records.size > 0;
      this.records.clear();
      return had;
    }
    return this.dropWhere((_record, recordId) => recordId === id || recordId.startsWith(`${id}/`));
  }

  private dropWhere(test: (record: StoredRecord, id: string) => boolean): boolean {
    let changed = false;
    for (const [id, record] of this.records) {
      if (test(record, id)) {
        this.records.delete(id);
        changed = true;
      }
    }
    return changed;
  }
}
