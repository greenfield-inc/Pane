// One Glassly notification per new question, so a card reaches the glasses while another miniapp
// is in front. Quiet while you are at a computer (any paired Pane says it is in use) and during a
// timed calendar event; when that event ends, one notification says how many waited.

/** Glassly's notification calls, which a Glassly App too old to post them refuses. */
export interface Poster {
  post(notification: { id: string; title: string; content: string }): Promise<void>;
  dismiss(id: string): Promise<void>;
  /** Reads a posted question aloud from the phone or Bluetooth headphones (G2 has no speaker). */
  speak(text: string): Promise<void>;
}

/** What Glassly rejects a request with: an Error, or a plain `{ code, message }` object. */
type Refusal = Error | { message?: string };

/** A question as a notification shows it. */
export interface Asked {
  key: string;
  title: string;
  /** "studio-mac · fix-login" */
  from: string;
}

export interface Moment {
  /** Waiting questions, newest first. */
  asked: readonly Asked[];
  /** Pane is drawing on the glasses and shows a new card itself. */
  inFront: boolean;
  /** Someone used one of the paired computers in the last 2 minutes. */
  inUse: boolean;
  /** The timed calendar event under way, if any. */
  meeting: { title: string } | null;
}

export const SUMMARY_ID = 'pane-meeting-summary';

export class Notifier {
  /** Questions already handled: posted, held back, or there before Pane started. */
  private readonly seen = new Set<string>();
  private readonly posted = new Set<string>();
  /** Questions that arrived during the current meeting. */
  private waited = 0;
  private meeting: string | null = null;
  private started = false;
  /** The newest question posted, which opening Pane shows. */
  newest: string | null = null;
  private unsupported = false;

  constructor(
    private readonly poster: Poster,
    private readonly log: (message: string) => void = () => {},
    /** Whether posted questions are also read aloud; off unless the wearer turns it on. */
    private readonly readAloud: () => boolean = () => false,
  ) {}

  update(moment: Moment): void {
    const waiting = new Set(moment.asked.map((asked) => asked.key));
    for (const key of [...this.posted]) {
      if (waiting.has(key)) continue;
      this.posted.delete(key);
      if (this.newest === key) this.newest = null;
      this.send(() => this.poster.dismiss(key));
    }
    if (!this.started) {
      // What was waiting before Pane started already reached you some other way.
      this.started = true;
      for (const key of waiting) this.seen.add(key);
    }
    const fresh = [...moment.asked].reverse().filter((asked) => !this.seen.has(asked.key));
    for (const asked of fresh) {
      this.seen.add(asked.key);
      if (moment.meeting) {
        this.waited += 1;
        continue;
      }
      if (moment.inFront || moment.inUse) continue;
      this.posted.add(asked.key);
      this.newest = asked.key;
      this.send(() => this.poster.post({ id: asked.key, title: asked.title, content: asked.from }));
      if (this.readAloud()) {
        // Read aloud follows the same quiet rules as the notification, and fails on its own.
        this.poster.speak(`${asked.from}: ${asked.title}`).catch((error: Refusal) => this.log(`[Pane glasses] not read aloud: ${error.message ?? 'refused'}`));
      }
    }
    if (this.meeting && !moment.meeting && this.waited > 0) {
      const count = this.waited;
      this.send(() => this.poster.post({ id: SUMMARY_ID, title: `${count} ${count === 1 ? 'question' : 'questions'} waited while you were in ${this.meeting}`, content: 'Open Pane to answer.' }));
    }
    if (!moment.meeting) this.waited = 0;
    this.meeting = moment.meeting?.title ?? null;
  }

  /** Opening Pane shows this question; it no longer needs a notification. */
  opened(): string | null {
    const newest = this.newest;
    this.newest = null;
    return newest;
  }

  private send(call: () => Promise<void>): void {
    if (this.unsupported) return;
    call().catch((error: Refusal) => {
      // An older Glassly App can't post; Pane works without it, so this is logged, not shown.
      this.unsupported = true;
      this.log(`[Pane glasses] notifications off: ${error.message ?? 'refused'}`);
    });
  }
}

/** The timed event under way at `now`, if any; all-day events don't make you busy. */
export function meetingAt(events: ReadonlyArray<{ title: string; startsAt: string; endsAt: string; allDay: boolean }>, now: number): { title: string } | null {
  const event = events.find((candidate) => !candidate.allDay && Date.parse(candidate.startsAt) <= now && now < Date.parse(candidate.endsAt));
  return event ? { title: event.title || 'a meeting' } : null;
}
