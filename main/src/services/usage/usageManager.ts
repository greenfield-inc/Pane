import { existsSync, type Stats } from 'fs';
import { stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { glob } from 'glob';
import { databaseService } from '../database';
import { UsageRepository } from './usageRepository';
import { UsageAggregator, resolveReportRange } from './usageAggregator';
import { isFileUnchanged, resolveStartOffset, scanJsonlFile } from './jsonlScanner';
import { cursorChatIdFromTranscript, listPaneCursorChats, type PaneCursorChat } from './cursorChats';
import { usageEventId } from './usageParser';
import { getPricingSource } from './modelPricing';
import { OpenRouterPriceProvider } from './openRouterPriceProvider';
import { getAppDirectory } from '../../utils/appDirectory';
import {
  DEFAULT_USAGE_RANGE_DAYS,
  USAGE_PARSER_VERSION,
  USAGE_RETENTION_DAYS,
  type UsageIndexStatus,
  type UsageByPaneReport,
  type UsageProvider,
  type UsageRateLimitSample,
  type UsageReport,
  type UsageReportRequest,
  type UsageTotals,
} from '../../../../shared/types/usage';

interface TranscriptRoot {
  provider: UsageProvider;
  path: string;
}

/** Which files under each root are transcripts. */
const TRANSCRIPT_GLOBS = {
  claude: '**/*.jsonl',
  codex: '**/*.jsonl',
  cursor: '**/agent-transcripts/**/*.jsonl',
} satisfies Record<UsageProvider, string>;

/** The Pane chat a Cursor transcript belongs to, which its lines never name. */
interface TranscriptAttribution {
  agentSessionId: string;
  cwd: string | null;
}

interface PaneCostsReport {
  fromMs: number;
  toMs: number;
  pricingAsOf: string;
  byPane: UsageByPaneReport;
  totals: UsageTotals;
}

/** Yield to the event loop every N files so a first scan never blocks the UI. */
const YIELD_EVERY_FILES = 25;
/** Complete discovery runs even when CLI transcript roots do not exist yet. */
const USAGE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function transcriptRoots(): TranscriptRoot[] {
  const home = homedir();
  return [
    { provider: 'claude', path: join(home, '.claude', 'projects') },
    { provider: 'codex', path: join(home, '.codex', 'sessions') },
    { provider: 'cursor', path: join(home, '.cursor', 'projects') },
  ];
}

/**
 * Indexes agent CLI transcripts so the usage page can report tokens, cost and
 * rolling-window utilisation.
 *
 * Read-only by construction: it never writes to, creates or deletes anything
 * under `~/.claude`, `~/.codex` or `~/.cursor`.
 *
 * Cursor transcripts are read only for chats Pane launched (see
 * `listPaneCursorChats`), and record messages without tokens.
 *
 * Known limitation: only the Electron host's home directory is scanned. On
 * Windows with WSL-based projects the agents write inside the distro's home,
 * which this does not reach.
 */
export class UsageManager {
  constructor(private readonly dependencies: {
    roots?: () => TranscriptRoot[];
    repository?: UsageRepository;
    scanFile?: typeof scanJsonlFile;
    createPriceProvider?: () => Pick<OpenRouterPriceProvider, 'start' | 'stop'>;
    cursorChats?: () => readonly PaneCursorChat[];
  } = {}) {}

  // Resolved on first use, not in the constructor: this module is imported at
  // load time and the database handle is only guaranteed after initialisation.
  private repositoryRef: UsageRepository | null = null;
  private aggregatorRef: UsageAggregator | null = null;
  private priceProvider: Pick<OpenRouterPriceProvider, 'start' | 'stop'> | null = null;
  private pollingTimer: NodeJS.Timeout | undefined;
  private started = false;
  private generation = 0;
  private scanQueue: Promise<void> = Promise.resolve();
  private pendingScan: Promise<void> | null = null;

  private status: UsageIndexStatus = {
    lastScanStartedMs: null,
    lastScanFinishedMs: null,
    filesTracked: 0,
    eventsIndexed: 0,
    rootsChecked: 0,
    missingRoots: [],
    scanning: false,
    filesScanned: 0,
    filesTotal: 0,
    lastError: null,
  };

  private get repository(): UsageRepository {
    if (!this.repositoryRef) this.repositoryRef = this.dependencies.repository ?? new UsageRepository(databaseService.getDb());
    return this.repositoryRef;
  }

  private get aggregator(): UsageAggregator {
    if (!this.aggregatorRef) this.aggregatorRef = new UsageAggregator(databaseService.getDb());
    return this.aggregatorRef;
  }

  /** Call after `app.whenReady()` — never at module load. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.priceProvider = this.dependencies.createPriceProvider?.() ?? new OpenRouterPriceProvider(getAppDirectory());
    this.priceProvider.start();

    try {
      this.repository.pruneOlderThan(Date.now() - USAGE_RETENTION_DAYS * DAY_MS);
    } catch (error) {
      console.error('[Usage] Retention sweep failed:', error);
    }

    void this.requestScan();
    this.pollingTimer = setInterval(() => {
      void this.requestScan();
    }, USAGE_POLL_INTERVAL_MS);
    this.pollingTimer.unref();
  }

  stop(): void {
    this.started = false;
    this.priceProvider?.stop();
    this.priceProvider = null;
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    this.pollingTimer = undefined;
    this.generation += 1;
    this.pendingScan = null;
    this.status = { ...this.status, scanning: false };
  }

  getStatus(): UsageIndexStatus {
    return {
      ...this.status,
      filesTracked: this.safeCount(() => this.repository.countFiles()),
      eventsIndexed: this.safeCount(() => this.repository.countEvents()),
    };
  }

  /** Force a full re-scan; used by the page's refresh action. */
  async rescan(): Promise<UsageIndexStatus> {
    await this.requestScan();
    return this.getStatus();
  }

  getReport(request?: UsageReportRequest): UsageReport {
    const nowMs = Date.now();
    const { fromMs, toMs, bucket } = resolveReportRange(request, nowMs, DEFAULT_USAGE_RANGE_DAYS);
    const providers = request?.providers;

    return {
      totals: this.aggregator.getTotals(fromMs, toMs, providers),
      series: this.aggregator.getSeries(fromMs, toMs, bucket, providers, request?.dayBoundariesMs),
      byModel: this.aggregator.getByModel(fromMs, toMs, providers),
      byProject: this.aggregator.getByProject(fromMs, toMs, providers),
      byPane: this.aggregator.getByPane(fromMs, toMs, providers),
      rateLimits: this.safeRateLimits(nowMs, providers),
      index: this.getStatus(),
      pricingAsOf: getPricingSource(),
    };
  }

  getPaneCosts(request?: UsageReportRequest): PaneCostsReport {
    const { fromMs, toMs } = resolveReportRange(request, Date.now(), DEFAULT_USAGE_RANGE_DAYS);
    const providers = request?.providers;
    return {
      fromMs,
      toMs,
      pricingAsOf: getPricingSource(),
      byPane: this.aggregator.getByPane(fromMs, toMs, providers),
      totals: this.aggregator.getTotals(fromMs, toMs, providers),
    };
  }

  /** Quota state, narrowed to the providers the page is showing. */
  private safeRateLimits(nowMs: number, providers?: UsageProvider[]): UsageRateLimitSample[] {
    try {
      const samples = this.repository.getRateLimits(nowMs);
      if (!providers || providers.length === 0) return samples;
      return samples.filter(sample => providers.includes(sample.provider));
    } catch {
      return [];
    }
  }

  private safeCount(read: () => number): number {
    try {
      return read();
    } catch {
      return 0;
    }
  }

  /** Coalesce queued refreshes, but always follow an active scan with a fresh pass. */
  private requestScan(): Promise<void> {
    if (this.pendingScan) return this.pendingScan;
    const generation = this.generation;
    const scan = this.scanQueue.then(async () => {
      if (generation !== this.generation) return;
      this.pendingScan = null;
      await this.runFullScan(generation);
    });
    this.pendingScan = scan;
    this.scanQueue = scan;
    return scan;
  }

  private async runFullScan(generation: number): Promise<void> {
    this.status = { ...this.status, scanning: true, lastScanStartedMs: Date.now(), filesScanned: 0, filesTotal: 0 };
    let scanError: string | null = null;

    try {
      const roots = this.dependencies.roots?.() ?? transcriptRoots();
      this.status.rootsChecked = roots.length;
      this.status.missingRoots = roots.filter(root => !existsSync(root.path)).map(root => root.path);

      const files: Array<{ path: string; provider: UsageProvider; attribution?: TranscriptAttribution }> = [];
      let cursorChats: Map<string, PaneCursorChat> | null = null;
      for (const root of roots) {
        if (!existsSync(root.path)) continue;
        const matches = await glob(TRANSCRIPT_GLOBS[root.provider], { cwd: root.path, absolute: true, nodir: true });
        if (generation !== this.generation) return;
        if (root.provider !== 'cursor') {
          for (const path of matches) files.push({ path, provider: root.provider });
          continue;
        }
        cursorChats ??= this.readCursorChats();
        for (const path of matches) {
          const chatId = cursorChatIdFromTranscript(path);
          const chat = chatId ? cursorChats.get(chatId) : undefined;
          // Chats Pane did not launch, such as the Cursor editor's, are never read.
          if (!chat) continue;
          files.push({ path, provider: 'cursor', attribution: { agentSessionId: chat.chatId, cwd: chat.cwd } });
        }
      }

      this.status.filesTotal = files.length;
      for (const file of files) {
        if (generation !== this.generation) return;
        try {
          await this.scanOne(file.path, file.provider, generation, file.attribution);
        } catch (error) {
          if (generation !== this.generation) return;
          // Keep indexing readable files, but report the pass as incomplete.
          if (scanError === null) {
            scanError = error instanceof Error ? error.message : String(error);
            console.warn(`[Usage] Skipped ${file.path}:`, scanError);
          }
        }
        if (generation !== this.generation) return;
        this.status.filesScanned += 1;
        if (this.status.filesScanned % YIELD_EVERY_FILES === 0) {
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
    } catch (error) {
      if (generation !== this.generation) return;
      scanError = error instanceof Error ? error.message : String(error);
      console.error('[Usage] Scan failed:', error);
    } finally {
      if (generation === this.generation) {
        this.status = {
          ...this.status,
          scanning: false,
          lastError: scanError,
          // Preserve the last successful reconciliation across errors and stop.
          lastScanFinishedMs: scanError === null ? Date.now() : this.status.lastScanFinishedMs,
        };
      }
    }
  }

  /**
   * Cursor transcripts are re-read in full whenever they change, because Cursor
   * may rewrite one in place and a resumed offset would land mid-line. Each
   * assistant line is identified by its position in the file, so a re-read
   * keeps the time a message was first indexed. Lines carry no time, so a new
   * message gets the transcript's last write, the latest it can be.
   */
  private async scanCursorTranscript(
    path: string,
    stats: Stats,
    attribution: TranscriptAttribution,
    generation: number,
  ): Promise<void> {
    const recorded = this.repository.getFileCursor(path);
    if (recorded?.parserVersion === USAGE_PARSER_VERSION && isFileUnchanged(recorded, stats)) return;

    const scanned = await (this.dependencies.scanFile ?? scanJsonlFile)(path, 'cursor', 0, stats.mtimeMs, null);
    if (generation !== this.generation) return;

    const indexedAt = this.repository.eventTimes(path);
    const writtenAt = Math.floor(stats.mtimeMs);
    const events = scanned.events.map(({ event }, position) => {
      const placed = { ...event, ...attribution, messageId: `${path}#${position}` };
      return {
        event: { ...placed, timestampMs: indexedAt.get(usageEventId(placed, path, 0)) ?? writtenAt },
        byteOffset: 0,
      };
    });
    this.repository.replaceFile(
      {
        path,
        provider: 'cursor',
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        offsetBytes: scanned.nextOffsetBytes,
        lastScannedMs: Date.now(),
        parserVersion: USAGE_PARSER_VERSION,
        parseContext: null,
      },
      events,
      Date.now(),
    );
  }

  /** Pane-launched Cursor chats by id; none when Pane's own records cannot be read. */
  private readCursorChats(): Map<string, PaneCursorChat> {
    try {
      const chats = this.dependencies.cursorChats?.() ?? listPaneCursorChats(databaseService.getDb());
      return new Map(chats.map(chat => [chat.chatId, chat]));
    } catch (error) {
      console.warn('[Usage] Skipped Cursor transcripts:', error instanceof Error ? error.message : error);
      return new Map();
    }
  }

  /**
   * Index one transcript, resuming from its stored cursor. Files whose size
   * and mtime are unchanged are skipped without being opened, which is what
   * makes subsequent launches fast.
   */
  private async scanOne(
    path: string,
    provider: UsageProvider,
    generation: number,
    attribution?: TranscriptAttribution,
  ): Promise<void> {
    try {
      const stats = await stat(path);
      if (generation !== this.generation) return;
      if (attribution) {
        await this.scanCursorTranscript(path, stats, attribution, generation);
        return;
      }
      let recorded = this.repository.getFileCursor(path);

      // A parser fix must reach transcripts that were already indexed, so a
      // version mismatch discards this file's rows and re-reads it in full.
      if (recorded && recorded.parserVersion !== USAGE_PARSER_VERSION) {
        this.repository.forgetFile(path);
        recorded = null;
      }

      if (isFileUnchanged(recorded, stats)) return;

      const startOffset = resolveStartOffset(recorded, stats.size);
      // A file being re-read from the top states its own attribution again, and
      // a stored context would describe bytes that are no longer there — this is
      // the rotation and truncation case.
      const seedContext = startOffset > 0 ? recorded?.parseContext ?? null : null;
      const scanned = await (this.dependencies.scanFile ?? scanJsonlFile)(path, provider, startOffset, stats.mtimeMs, seedContext);
      if (generation !== this.generation) return;

      this.repository.commitFile(
        {
          path,
          provider,
          sizeBytes: stats.size,
          mtimeMs: stats.mtimeMs,
          offsetBytes: scanned.nextOffsetBytes,
          lastScannedMs: Date.now(),
          parserVersion: USAGE_PARSER_VERSION,
          parseContext: scanned.context,
        },
        scanned.events,
        Date.now()
      );

      this.repository.recordRateLimits(scanned.rateLimits);
    } catch (error) {
      if (generation !== this.generation) return;
      // A disappeared transcript must not abort the pass.
      // SAFETY: Node filesystem failures may carry the optional errno code.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        this.repository.forgetFile(path);
        return;
      }
      throw error;
    }
  }
}

export const usageManager = new UsageManager();
