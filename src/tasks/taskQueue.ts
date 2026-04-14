// ─────────────────────────────────────────────────────────────────────────────
// tasks/taskQueue.ts — Simple concurrency-capped async queue (no extra deps)
// ─────────────────────────────────────────────────────────────────────────────

type Task<T> = () => Promise<T>;

export class AsyncQueue<T> {
  private readonly maxConcurrency: number;
  private running = 0;
  private readonly queue: Array<{
    task: Task<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  add(task: Task<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.tick();
    });
  }

  private tick(): void {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.running++;
      next
        .task()
        .then(next.resolve, next.reject)
        .finally(() => {
          this.running--;
          this.tick();
        });
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.running;
  }
}
