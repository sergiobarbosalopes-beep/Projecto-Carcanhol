export class WorkerBusyError extends Error {}
export class WorkerAbortedError extends Error {}

type QueuedPermit = {
  grant: () => void;
  reject: (error: WorkerAbortedError) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class ConcurrencyGate {
  private active = 0;
  private readonly queue: QueuedPermit[] = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxQueue: number
  ) {
    if (maxConcurrency < 1 || maxQueue < 0) {
      throw new Error("Invalid concurrency limits.");
    }
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);

    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new WorkerAbortedError();
    }

    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }

    if (this.queue.length >= this.maxQueue) {
      throw new WorkerBusyError();
    }

    await new Promise<void>((resolve, reject) => {
      const permit: QueuedPermit = {
        grant: () => {
          this.removeAbortListener(permit);
          resolve();
        },
        reject,
        ...(signal ? { signal } : {}),
      };

      if (signal) {
        permit.onAbort = () => {
          const index = this.queue.indexOf(permit);

          if (index >= 0) {
            this.queue.splice(index, 1);
          }

          this.removeAbortListener(permit);
          reject(new WorkerAbortedError());
        };
        signal.addEventListener("abort", permit.onAbort, { once: true });
      }

      this.queue.push(permit);
    });
  }

  private release() {
    const next = this.queue.shift();

    if (next) {
      next.grant();
      return;
    }

    this.active -= 1;
  }

  private removeAbortListener(permit: QueuedPermit) {
    if (permit.signal && permit.onAbort) {
      permit.signal.removeEventListener("abort", permit.onAbort);
    }
  }
}
