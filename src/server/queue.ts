// The single in-process processing queue that sits behind JSONL uploads. Uploads save their blob and
// enqueue a task immediately; this drains them ONE AT A TIME in the background (parse → metrics → cost
// → historical-pricing fetch). Deliberately minimal: no persistence, no priorities, one queue. A task
// that throws is logged and skipped so one bad transcript can't wedge the queue.
export class SerialQueue {
  private queue: Array<() => Promise<void>> = [];
  private active: Promise<void> | null = null;

  enqueue(task: () => Promise<void>) {
    this.queue.push(task);
    if (!this.active) {
      this.active = this.drain().finally(() => {
        this.active = null;
      });
    }
  }

  // Resolves once the queue is fully drained — used by tests and graceful shutdown.
  async settle() {
    while (this.active) await this.active;
  }

  get size() {
    return this.queue.length + (this.active ? 1 : 0);
  }

  private async drain() {
    while (this.queue.length) {
      const task = this.queue.shift() as () => Promise<void>;
      try {
        await task();
      } catch (err) {
        console.warn(`[finius] processing job failed: ${(err as Error).message}`);
      }
    }
  }
}
