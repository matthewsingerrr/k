/**
 * Concurrency primitives used by the HTTP client and monitors.
 */

/** Normalizes a concurrency limit: NaN/<1 → 1, fractional → floor, Infinity stays unlimited. */
function normalizeLimit(n: number): number {
  if (Number.isNaN(n) || n < 1) return 1;
  return n === Infinity ? Infinity : Math.floor(n);
}

/** FIFO queue with O(1) amortized shift (Array#shift is O(n) and the global queue can get long). */
class Fifo<T> {
  private items: T[] = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  push(item: T): void {
    this.items.push(item);
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head];
    this.items[this.head] = undefined as T; // drop the reference for GC
    this.head++;
    if (this.head === this.items.length) {
      this.items = [];
      this.head = 0;
    } else if (this.head >= 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }
}

/** Counting semaphore. `run(fn)` waits for a free slot, runs fn, releases the slot even if fn throws. FIFO fairness. */
export class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiters = new Fifo<() => void>();

  constructor(public readonly max: number) {
    this.#limit = normalizeLimit(max);
  }

  /** Number of tasks currently running. */
  get active(): number {
    return this.#active;
  }

  /** Number of tasks waiting for a slot. */
  get pending(): number {
    return this.#waiters.length;
  }

  /** True when nothing is running or queued. */
  get idle(): boolean {
    return this.#active === 0 && this.#waiters.length === 0;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Acquisition is synchronous when a slot is free (and queueing is synchronous otherwise), which
    // KeyedLimiter relies on to avoid racing its idle-key GC.
    if (this.#active < this.#limit && this.#waiters.length === 0) {
      this.#active++;
    } else {
      // The releasing task hands its slot over directly, so #active is not touched here.
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#active--;
  }
}

/**
 * One Semaphore per key (e.g. hostname), created lazily with `maxPerKey` slots and
 * garbage-collected when idle (no active/pending tasks) so the map does not grow unbounded.
 */
export class KeyedLimiter {
  readonly #sems = new Map<string, Semaphore>();

  constructor(public readonly maxPerKey: number) {}

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let sem = this.#sems.get(key);
    if (!sem) {
      sem = new Semaphore(this.maxPerKey);
      this.#sems.set(key, sem);
    }
    try {
      return await sem.run(fn);
    } finally {
      if (sem.idle && this.#sems.get(key) === sem) this.#sems.delete(key);
    }
  }

  /** Number of keys with live semaphores (for tests). */
  get size(): number {
    return this.#sems.size;
  }

  /** Tasks currently running across all keys. */
  get active(): number {
    let n = 0;
    for (const s of this.#sems.values()) n += s.active;
    return n;
  }

  /** Tasks waiting for a slot across all keys. */
  get pending(): number {
    let n = 0;
    for (const s of this.#sems.values()) n += s.pending;
    return n;
  }
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight; results keep input order.
 * A rejected fn rejects the whole call: no new items are started after the first failure, the
 * already-running ones are allowed to settle (so nothing keeps working in the background), and
 * then the call rejects with the first error.
 */
export async function mapLimit<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const count = items.length;
  const results = new Array<R>(count);
  if (count === 0) return results;

  let next = 0;
  let failure: { error: unknown } | null = null;

  const worker = async (): Promise<void> => {
    while (failure === null && next < count) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (error) {
        if (failure === null) failure = { error };
      }
    }
  };

  const workers = Math.min(count, normalizeLimit(concurrency));
  await Promise.all(Array.from({ length: workers }, worker));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return results;
}

/** Promise that resolves after `ms` milliseconds (unref'd timer so it never keeps the process alive). */
export function sleep(ms: number): Promise<void> {
  // setTimeout fires immediately for delays above 2^31-1, so clamp.
  const delay = Number.isNaN(ms) || ms <= 0 ? 0 : Math.min(ms, 2_147_483_647);
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delay);
    if (typeof timer === 'object' && typeof timer?.unref === 'function') timer.unref();
  });
}
