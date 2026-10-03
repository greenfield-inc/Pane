import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import Database from 'better-sqlite3-multiple-ciphers';
import type { Database as DatabaseHandle } from 'better-sqlite3-multiple-ciphers';
import {
  USAGE_PARSER_VERSION,
  USAGE_RETENTION_DAYS,
  type UsageEvent,
  type UsageRateLimitSample,
} from '../../../../shared/types/usage';
import {
  boundary,
  decodeBoundary,
  decodeOptionalBoundary,
  type BoundarySchema,
  type JsonObject,
  type JsonValue,
} from '../../../../shared/validation/boundaryDecoder';
import type { UsageRepository } from './usageRepository';

const execFileAsync = promisify(execFile);

/** Synthetic transcript path for Cursor rows and the sync watermark. */
export const CURSOR_USAGE_SOURCE = 'cursor://pane-agents';
const CURSOR_API_ORIGIN = 'https://api2.cursor.sh';
const PERIOD_USAGE_PATH = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const FILTERED_EVENTS_PATH = '/aiserver.v1.DashboardService/GetFilteredUsageEvents';
const PAGE_SIZE = 500;
const MAX_PAGES = 40;
const REQUEST_TIMEOUT_MS = 20_000;
/** Trailing window re-fetched after the first sync, because open requests keep growing. */
const REFETCH_WINDOW_MS = 48 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PaneCursorChat {
  chatId: string;
  cwd: string;
}

interface CursorAuth {
  accessToken: string;
  planType: string | null;
}

interface FilteredUsageEvent {
  timestampMs: number;
  model: string;
  conversationId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface CursorWindow {
  events: FilteredUsageEvent[];
  period: JsonObject | null;
}

type FetchLike = typeof fetch;

/**
 * Cursor dashboard model names become the bundled price ids.
 * `Composer 2.5 (Fast)` and `composer-2.5-fast` land on the same row.
 */
export function normalizeCursorModelId(model: string): string {
  const normalized = model
    .trim()
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // Dashboard ids look like `cursor-grok-4.6-high-fast`. The price table uses
  // `grok-4.6-fast`; the effort segment is not a separate rate.
  const withoutVendor = normalized.replace(/^cursor-(?=grok-|composer-)/, '');
  return withoutVendor.replace(/-(?:xhigh|medium|high|low)(?=-|$)/g, '');
}

const numericText = boundary.union(boundary.number, boundary.string);

function finiteNumber(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const numeric = decodeOptionalBoundary(value, boundary.number);
  const raw = numeric ?? Number(String(value));
  return Number.isFinite(raw) ? raw : null;
}

function countFrom(value: JsonValue | undefined): number {
  const raw = finiteNumber(decodeOptionalBoundary(value, numericText));
  if (raw === null) return 0;
  return Math.max(0, Math.round(raw));
}

function percentFrom(value: JsonValue | undefined): number | null {
  const raw = finiteNumber(decodeOptionalBoundary(value, numericText));
  if (raw === null) return null;
  return Math.max(0, Math.min(100, raw));
}

function timestampMsFrom(value: number | string | undefined): number | null {
  const raw = finiteNumber(value);
  if (raw === null || raw <= 0) return null;
  return raw > 1e12 ? raw : raw * 1000;
}

const sqliteText: BoundarySchema<string> = {
  decode(current) {
    const text = decodeOptionalBoundary(current.value, boundary.string);
    if (text !== undefined) return text;
    if (Buffer.isBuffer(current.value)) return current.value.toString('utf8');
    return current.fail('expected sqlite text');
  },
};

function jsonObjectFrom(value: JsonValue | null | undefined): JsonObject | null {
  return decodeOptionalBoundary(value ?? undefined, boundary.jsonObject) ?? null;
}

function cursorStateDbPath(): string {
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function readStateDbAuth(path: string): CursorAuth | null {
  if (!existsSync(path)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const read = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
    const cell = boundary.object({
      value: boundary.optional(boundary.nullable(sqliteText)),
    });
    const token = readStoredText(decodeOptionalBoundary(read.get('cursorAuth/accessToken'), cell)?.value);
    if (!token) return null;
    const planType = readStoredText(decodeOptionalBoundary(read.get('cursorAuth/stripeMembershipType'), cell)?.value);
    return { accessToken: token, planType };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function readStoredText(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^"|"$/g, '');
  return trimmed.length > 0 ? trimmed : null;
}

async function readKeychainToken(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', 'cursor-access-token', '-w'], {
      timeout: 3000,
      encoding: 'utf8',
    });
    const token = stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Cursor's stored login. The token is not written, logged, or copied into Pane's database. */
async function readCursorAuth(): Promise<CursorAuth | null> {
  const fromDb = readStateDbAuth(cursorStateDbPath());
  if (fromDb) return fromDb;
  const token = await readKeychainToken();
  return token ? { accessToken: token, planType: null } : null;
}

const CHAT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cursor CLI stores one directory per workspace, named by the md5 of its path. */
export function cursorCliWorkspaceHash(worktreePath: string): string {
  return createHash('md5').update(worktreePath).digest('hex');
}

function cursorCliChatsRoot(): string {
  return join(homedir(), '.cursor', 'chats');
}

/**
 * Chat ids the Cursor CLI wrote for a Pane worktree.
 * `agent` launches never go through create-chat, so they are not on the panel.
 */
function listCursorCliChats(
  worktreePaths: readonly string[],
  chatsRoot: string,
): PaneCursorChat[] {
  const chats: PaneCursorChat[] = [];
  const seen = new Set<string>();
  for (const cwd of worktreePaths) {
    if (!cwd) continue;
    const directory = join(chatsRoot, cursorCliWorkspaceHash(cwd));
    if (!existsSync(directory)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!CHAT_UUID.test(name) || seen.has(name)) continue;
      seen.add(name);
      chats.push({ chatId: name, cwd });
    }
  }
  return chats;
}

function listSessionWorktrees(db: DatabaseHandle): string[] {
  const rows = decodeBoundary(db.prepare(`
    SELECT DISTINCT worktree_path AS cwd
    FROM sessions
    WHERE typeof(worktree_path) = 'text' AND length(worktree_path) > 0
  `).all(), boundary.array(boundary.object({ cwd: boundary.string })));
  return rows.map(row => row.cwd);
}

/** Chat ids Pane captured at Cursor launch, including archived Panes that still have their panels. */
export function listPaneCursorChats(db: DatabaseHandle, chatsRoot = cursorCliChatsRoot()): PaneCursorChat[] {
  const rows = decodeBoundary(db.prepare(`
    SELECT json_extract(tp.state, '$.customState.agentSessionId') AS chat_id,
           s.worktree_path AS cwd
    FROM tool_panels tp
    JOIN sessions s ON s.id = tp.session_id
    WHERE json_extract(tp.state, '$.customState.agentType') = 'cursor'
    ORDER BY s.updated_at DESC
  `).all(), boundary.array(boundary.object({
    chat_id: boundary.nullable(boundary.string),
    cwd: boundary.nullable(boundary.string),
  })));

  const chats = new Map<string, string>();
  for (const row of rows) {
    const chatId = row.chat_id?.trim() ?? '';
    if (chatId.length === 0 || chats.has(chatId)) continue;
    chats.set(chatId, row.cwd ?? '');
  }
  for (const chat of listCursorCliChats(listSessionWorktrees(db), chatsRoot)) {
    if (!chats.has(chat.chatId)) chats.set(chat.chatId, chat.cwd);
  }
  return [...chats.entries()].map(([chatId, cwd]) => ({ chatId, cwd }));
}

const usageEventRow = boundary.object({
  timestamp: boundary.optional(numericText),
  model: boundary.optional(boundary.string),
  conversationId: boundary.optional(boundary.string),
  tokenUsage: boundary.optional(boundary.jsonObject),
});

function eventRowsFrom(body: JsonObject): JsonValue[] | null {
  return decodeOptionalBoundary(body.usageEventsDisplay, boundary.array(boundary.json))
    ?? decodeOptionalBoundary(body.usageEvents, boundary.array(boundary.json))
    ?? null;
}

function rawUsageRowCount(payload: JsonValue | null): number {
  const body = jsonObjectFrom(payload);
  if (!body) return 0;
  return eventRowsFrom(body)?.length ?? 0;
}

export function parseFilteredUsageEvents(payload: JsonValue): FilteredUsageEvent[] {
  const body = jsonObjectFrom(payload);
  if (!body) return [];
  const rows = eventRowsFrom(body);
  if (!rows) {
    const total = decodeOptionalBoundary(body.totalUsageEventsCount, numericText);
    const namedList = 'usageEventsDisplay' in body || 'usageEvents' in body;
    if (namedList || Object.keys(body).length === 0 || total === 0 || total === '0') return [];
    throw new Error('Cursor usage response did not include events');
  }

  const events: FilteredUsageEvent[] = [];
  for (const row of rows) {
    const record = decodeOptionalBoundary(row, usageEventRow);
    if (!record) continue;
    const conversationId = record.conversationId?.trim() ?? '';
    const timestampMs = timestampMsFrom(record.timestamp);
    const model = record.model ? normalizeCursorModelId(record.model) : '';
    if (!conversationId || timestampMs === null || !model) continue;

    const inputTokens = countFrom(record.tokenUsage?.inputTokens);
    const outputTokens = countFrom(record.tokenUsage?.outputTokens);
    const cacheReadTokens = countFrom(record.tokenUsage?.cacheReadTokens);
    const cacheCreationTokens = countFrom(record.tokenUsage?.cacheWriteTokens);
    if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens === 0) continue;

    events.push({
      timestampMs,
      model,
      conversationId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    });
  }
  return events;
}

/** Keep dashboard rows whose conversation id is a Cursor chat Pane captured. */
export function selectPaneCursorEvents(
  events: FilteredUsageEvent[],
  chats: readonly PaneCursorChat[],
): UsageEvent[] {
  const cwdByChat = new Map(chats.map(chat => [chat.chatId, chat.cwd]));
  const merged = new Map<string, UsageEvent>();

  for (const event of events) {
    const cwd = cwdByChat.get(event.conversationId);
    if (cwd === undefined) continue;
    const messageId = `${event.conversationId}:${event.timestampMs}:${event.model}`;
    const existing = merged.get(messageId);
    if (existing) {
      existing.inputTokens += event.inputTokens;
      existing.outputTokens += event.outputTokens;
      existing.cacheReadTokens += event.cacheReadTokens;
      existing.cacheCreationTokens += event.cacheCreationTokens;
      continue;
    }
    merged.set(messageId, {
      provider: 'cursor',
      timestampMs: event.timestampMs,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      agentSessionId: event.conversationId,
      messageId,
      cwd: cwd.length > 0 ? cwd : null,
    });
  }

  return [...merged.values()];
}

export function mapCursorPeriodLimits(
  period: JsonValue | null,
  planType: string | null,
  capturedAtMs: number,
): UsageRateLimitSample[] {
  const body = decodeOptionalBoundary(period ?? undefined, boundary.object({
    billingCycleStart: boundary.optional(numericText),
    billingCycleEnd: boundary.optional(numericText),
    planUsage: boundary.optional(boundary.object({
      autoPercentUsed: boundary.optional(boundary.json),
      apiPercentUsed: boundary.optional(boundary.json),
    })),
  }));
  if (!body?.planUsage) return [];

  const cycleStart = timestampMsFrom(body.billingCycleStart);
  const cycleEnd = timestampMsFrom(body.billingCycleEnd);
  const windowMinutes = cycleStart !== null && cycleEnd !== null && cycleEnd > cycleStart
    ? Math.round((cycleEnd - cycleStart) / 60_000)
    : null;

  const meters: Array<{ id: string; name: string; scope: 'primary' | 'secondary'; value: JsonValue | undefined }> = [
    { id: 'auto', name: 'Auto', scope: 'primary', value: body.planUsage.autoPercentUsed },
    { id: 'api', name: 'API', scope: 'secondary', value: body.planUsage.apiPercentUsed },
  ];

  return meters.flatMap(meter => {
    const usedPercent = percentFrom(meter.value);
    if (usedPercent === null) return [];
    return [{
      provider: 'cursor',
      limitId: meter.id,
      scope: meter.scope,
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      windowMinutes,
      resetsAtMs: cycleEnd,
      planType,
      capturedAtMs,
      creditsHas: null,
      creditsBalance: null,
      creditsUnlimited: null,
      rateLimitReachedType: null,
      spendControlReached: null,
      limitName: meter.name,
    }];
  });
}

async function postDashboard(
  accessToken: string,
  path: string,
  body: JsonObject,
  fetchImpl: FetchLike,
): Promise<{ status: number; payload: JsonValue | null }> {
  const response = await fetchImpl(`${CURSOR_API_ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) return { status: response.status, payload: null };
  if (!response.ok) {
    throw new Error(`Cursor usage request failed (${response.status})`);
  }
  const payload = decodeBoundary(await response.json(), boundary.json);
  return { status: response.status, payload };
}

/**
 * Read the billing-period meters and every usage event in the window.
 * Throws when a page fails or the page cap is hit, so the caller can keep the previous index.
 */
export async function loadCursorWindow(
  accessToken: string,
  fromMs: number,
  toMs: number,
  fetchImpl: FetchLike = fetch,
): Promise<{ status: 'unauthorized' } | { status: 'ok'; window: CursorWindow }> {
  const period = await postDashboard(accessToken, PERIOD_USAGE_PATH, {}, fetchImpl);
  if (period.status === 401 || period.status === 403) return { status: 'unauthorized' };

  const events: FilteredUsageEvent[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await postDashboard(accessToken, FILTERED_EVENTS_PATH, {
      startDate: String(fromMs),
      endDate: String(toMs),
      page,
      pageSize: PAGE_SIZE,
    }, fetchImpl);
    if (response.status === 401 || response.status === 403) return { status: 'unauthorized' };
    const pageEvents = parseFilteredUsageEvents(response.payload);
    events.push(...pageEvents);
    // Skipped rows (no tokens) must not end the scan. A short raw page does.
    if (rawUsageRowCount(response.payload) < PAGE_SIZE) {
      return { status: 'ok', window: { events, period: jsonObjectFrom(period.payload) } };
    }
  }
  throw new Error('Cursor usage event pages exceeded the cap');
}

/**
 * Index Cursor usage for Pane-captured chat ids.
 * Missing login is a no-op. A rejected login does not change the index.
 */
export async function syncCursorUsage(
  repository: UsageRepository,
  db: DatabaseHandle,
  nowMs = Date.now(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const auth = await readCursorAuth();
  if (!auth) return;

  // A watermark with no rows is not a completed sync. The first pass can
  // commit the marker before any Pane chat is reached, and the 48h window
  // would never go back for those older events.
  const chats = listPaneCursorChats(db);
  const storedCursorEvents = decodeOptionalBoundary(db.prepare(
    'SELECT COUNT(*) AS count FROM usage_events WHERE provider = ?',
  ).get('cursor'), boundary.object({ count: boundary.number }));
  const storedSessionIds = new Set(decodeBoundary(db.prepare(`
    SELECT DISTINCT agent_session_id AS id
    FROM usage_events
    WHERE provider = ? AND agent_session_id IS NOT NULL
  `).all('cursor'), boundary.array(boundary.object({ id: boundary.string }))).map(row => row.id));
  const missingChat = chats.some(chat => !storedSessionIds.has(chat.chatId));
  const hasSynced = repository.getFileCursor(CURSOR_USAGE_SOURCE) !== null
    && (storedCursorEvents?.count ?? 0) > 0
    && !missingChat;
  const fromMs = hasSynced ? nowMs - REFETCH_WINDOW_MS : nowMs - USAGE_RETENTION_DAYS * DAY_MS;
  const loaded = await loadCursorWindow(auth.accessToken, fromMs, nowMs, fetchImpl);
  if (loaded.status === 'unauthorized') {
    console.warn('[Usage] Cursor usage is unavailable. Open Cursor to refresh its login.');
    return;
  }

  const events = selectPaneCursorEvents(loaded.window.events, chats)
    .filter(event => event.timestampMs >= fromMs && event.timestampMs <= nowMs);
  repository.replaceProviderWindow({
    sourcePath: CURSOR_USAGE_SOURCE,
    provider: 'cursor',
    fromMs,
    toMs: nowMs,
    events,
    limits: mapCursorPeriodLimits(loaded.window.period, auth.planType, nowMs),
    nowMs,
    parserVersion: USAGE_PARSER_VERSION,
    keepSessionIds: chats.map(chat => chat.chatId),
  });
}
