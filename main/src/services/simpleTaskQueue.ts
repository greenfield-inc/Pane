import { EventEmitter } from 'events';
import { AsyncLocalStorage } from 'async_hooks';

export interface Job<T, R> {
  id: string;
  data: T;
  status: 'pending' | 'active' | 'completed' | 'failed';
  result?: R;
  error?: Error;
}

export class SimpleQueue<T, R = unknown> extends EventEmitter {
  private jobs: Map<string, Job<T, R>> = new Map();
  private queue: string[] = [];
  private processing = false;
  private concurrency: number;
  private processor?: (job: Job<T, R>) => Promise<R>;
  private jobIdCounter = 0;
  /** Each job runs in the async context that added it, not the one of the job that finished before it. */
  private readonly contexts = new Map<string, <Result>(work: () => Result) => Result>();

  constructor(name: string, concurrency = 1) {
    super();
    this.concurrency = concurrency;
  }

  process(concurrency: number, processor: (job: Job<T, R>) => Promise<R>) {
    this.concurrency = concurrency;
    this.processor = processor;
    this.startProcessing();
  }

  async add(data: T): Promise<Job<T, R>> {
    const job: Job<T, R> = {
      id: String(++this.jobIdCounter),
      data,
      status: 'pending'
    };

    this.jobs.set(job.id, job);
    this.contexts.set(job.id, AsyncLocalStorage.snapshot());
    this.queue.push(job.id);
    
    this.emit('waiting', job);
    
    // Start processing if not already running
    this.startProcessing();
    
    return job;
  }

  private activeJobs = 0;

  private async startProcessing() {
    if (!this.processor) {
      return;
    }

    // Process multiple jobs concurrently up to the concurrency limit
    while (this.queue.length > 0 && this.activeJobs < this.concurrency) {
      this.processNextJob();
    }
  }

  private async processNextJob() {
    const jobId = this.queue.shift();
    if (!jobId) return;
    
    const job = this.jobs.get(jobId);
    if (!job) return;
    
    this.activeJobs++;
    job.status = 'active';
    this.emit('active', job);
    
    try {
      const processor = this.processor!;
      const inContext = this.contexts.get(jobId);
      this.contexts.delete(jobId);
      const result = await (inContext ? inContext(() => processor(job)) : processor(job));
      job.status = 'completed';
      job.result = result;
      this.emit('completed', job, result);
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error : new Error(String(error));
      console.error(`[SimpleQueue] Job ${job.id} failed:`, error);
      this.emit('failed', job, error);
    }
    
    this.activeJobs--;
    
    // Clean up completed job after a delay
    setTimeout(() => {
      this.jobs.delete(jobId);
    }, 5000);
    
    // Process next job if available
    if (this.queue.length > 0) {
      this.processNextJob();
    }
  }

  on(event: 'active' | 'waiting', listener: (job: Job<T, R>) => void): this;
  on(event: 'completed', listener: (job: Job<T, R>, result: R) => void): this;
  on(event: 'failed', listener: (job: Job<T, R>, error: Error) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string, listener: Parameters<EventEmitter['on']>[1]): this {
    return super.on(event, listener);
  }

  async close() {
    // Clean up
    this.queue = [];
    this.jobs.clear();
    this.contexts.clear();
  }
}
