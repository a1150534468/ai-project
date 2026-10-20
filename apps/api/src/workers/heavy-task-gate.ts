import { envInt } from "../runtime/env.js";

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiting.shift()?.();
  }
}

let gate: Semaphore | null = null;

export function runHeavyWorkerTask<T>(work: () => Promise<T>): Promise<T> {
  gate ??= new Semaphore(envInt(process.env, "HEAVY_TASK_CONCURRENCY", 1));
  return gate.run(work);
}
