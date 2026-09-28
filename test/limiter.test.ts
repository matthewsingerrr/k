import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyedLimiter, Semaphore, mapLimit, sleep } from '../src/net/limiter.js';

/** A promise plus its resolve/reject, for driving tasks by hand. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks / promise chains run. */
async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Semaphore', () => {
  it('never runs more than max tasks at once', async () => {
    const sem = new Semaphore(3);
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 20 }, (_, i) =>
      sem.run(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(1 + (i % 4));
        inFlight--;
        return i;
      }),
    );
    expect(await Promise.all(tasks)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(peak).toBe(3);
    expect(sem.active).toBe(0);
    expect(sem.pending).toBe(0);
  });

  it('reports active and pending counts and grants slots in FIFO order', async () => {
    const sem = new Semaphore(1);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((g, i) =>
      sem.run(async () => {
        started.push(i);
        await g.promise;
        return i;
      }),
    );
    await flush();
    expect(sem.active).toBe(1);
    expect(sem.pending).toBe(3);
    expect(started).toEqual([0]);

    gates[0].resolve();
    await flush();
    expect(started).toEqual([0, 1]);
    expect(sem.active).toBe(1);
    expect(sem.pending).toBe(2);

    // A newcomer queues behind every existing waiter.
    const late = sem.run(async () => {
      started.push(99);
    });
    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    await Promise.all([...runs, late]);
    expect(started).toEqual([0, 1, 2, 3, 99]);
    expect(sem.active).toBe(0);
    expect(sem.pending).toBe(0);
  });

  it('releases the slot when the task rejects or throws synchronously', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error('async boom')))).rejects.toThrow('async boom');
    await expect(
      sem.run((() => {
        throw new Error('sync boom');
      }) as () => Promise<void>),
    ).rejects.toThrow('sync boom');
    expect(sem.active).toBe(0);
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('treats a non-positive or NaN max as 1 and keeps the given value visible', async () => {
    for (const max of [0, -5, Number.NaN]) {
      const sem = new Semaphore(max);
      const gate = deferred();
      const a = sem.run(() => gate.promise);
      const b = sem.run(async () => 'b');
      await flush();
      expect(sem.active).toBe(1);
      expect(sem.pending).toBe(1);
      gate.resolve();
      await Promise.all([a, b]);
    }
    expect(new Semaphore(7).max).toBe(7);
  });

  it('floors fractional limits and supports Infinity', async () => {
    const sem = new Semaphore(2.9);
    const gate = deferred();
    const runs = [0, 1, 2].map(() => sem.run(() => gate.promise));
    await flush();
    expect(sem.active).toBe(2);
    gate.resolve();
    await Promise.all(runs);

    const unlimited = new Semaphore(Infinity);
    const gate2 = deferred();
    const many = Array.from({ length: 50 }, () => unlimited.run(() => gate2.promise));
    await flush();
    expect(unlimited.active).toBe(50);
    expect(unlimited.pending).toBe(0);
    gate2.resolve();
    await Promise.all(many);
  });

  it('handles a long queue without losing tasks', async () => {
    const sem = new Semaphore(2);
    const n = 5000;
    let done = 0;
    await Promise.all(
      Array.from({ length: n }, () =>
        sem.run(async () => {
          done++;
        }),
      ),
    );
    expect(done).toBe(n);
    expect(sem.pending).toBe(0);
    expect(sem.active).toBe(0);
  });
});

describe('KeyedLimiter', () => {
  it('limits concurrency per key independently', async () => {
    const limiter = new KeyedLimiter(2);
    const inFlight = new Map<string, number>();
    const peak = new Map<string, number>();
    let globalPeak = 0;
    let total = 0;
    const task = (key: string) =>
      limiter.run(key, async () => {
        inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
        total++;
        peak.set(key, Math.max(peak.get(key) ?? 0, inFlight.get(key)!));
        globalPeak = Math.max(globalPeak, total);
        await sleep(2);
        inFlight.set(key, inFlight.get(key)! - 1);
        total--;
      });
    await Promise.all([...Array.from({ length: 10 }, () => task('a.com')), ...Array.from({ length: 10 }, () => task('b.com'))]);
    expect(peak.get('a.com')).toBe(2);
    expect(peak.get('b.com')).toBe(2);
    expect(globalPeak).toBe(4);
  });

  it('garbage-collects idle keys', async () => {
    const limiter = new KeyedLimiter(1);
    const gateA = deferred();
    const gateB = deferred();
    const a1 = limiter.run('a', () => gateA.promise);
    const a2 = limiter.run('a', async () => 'a2');
    const b = limiter.run('b', () => gateB.promise);
    await flush();
    expect(limiter.size).toBe(2);
    expect(limiter.active).toBe(2);
    expect(limiter.pending).toBe(1);

    gateA.resolve();
    await Promise.all([a1, a2]);
    expect(limiter.size).toBe(1);

    gateB.reject(new Error('fail'));
    await expect(b).rejects.toThrow('fail');
    expect(limiter.size).toBe(0);
    expect(limiter.active).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  it('does not grow with many distinct keys', async () => {
    const limiter = new KeyedLimiter(3);
    await mapLimit(
      Array.from({ length: 1000 }, (_, i) => `host-${i}`),
      50,
      (key) => limiter.run(key, async () => key),
    );
    expect(limiter.size).toBe(0);
  });

  it('keeps sharing one semaphore when a new task arrives as the last one finishes', async () => {
    const limiter = new KeyedLimiter(1);
    let inFlight = 0;
    let peak = 0;
    const task = () =>
      limiter.run('k', async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight--;
      });
    const first = task();
    const chained = first.then(() => Promise.all([task(), task()]));
    await chained;
    expect(peak).toBe(1);
    expect(limiter.size).toBe(0);
  });
});

describe('mapLimit', () => {
  it('preserves input order and passes the index', async () => {
    const items = [50, 10, 30, 0, 20, 5];
    const out = await mapLimit(items, 3, async (ms, i) => {
      await sleep(ms);
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:50', '1:10', '2:30', '3:0', '4:20', '5:5']);
  });

  it('respects the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 30 }, (_, i) => i), 4, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(i % 3);
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  it('returns [] for no items without calling fn', async () => {
    const fn = vi.fn(async () => 1);
    expect(await mapLimit([], 5, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('treats a bad concurrency as 1', async () => {
    for (const c of [0, -1, Number.NaN]) {
      let inFlight = 0;
      let peak = 0;
      const out = await mapLimit([1, 2, 3], c, async (x) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(1);
        inFlight--;
        return x * 2;
      });
      expect(out).toEqual([2, 4, 6]);
      expect(peak).toBe(1);
    }
  });

  it('caps workers at the number of items for huge concurrency', async () => {
    const out = await mapLimit(['a', 'b'], Infinity, async (x) => x.toUpperCase());
    expect(out).toEqual(['A', 'B']);
  });

  it('rejects with the first error, starts nothing new, and lets in-flight tasks settle first', async () => {
    const started: number[] = [];
    const settled: number[] = [];
    const slow = deferred();
    const promise = mapLimit([0, 1, 2, 3, 4, 5], 2, async (i) => {
      started.push(i);
      try {
        if (i === 0) {
          await slow.promise;
          return i;
        }
        if (i === 1) throw new Error('first failure');
        if (i === 2) throw new Error('second failure');
        return i;
      } finally {
        settled.push(i);
      }
    });
    let rejected = false;
    promise.catch(() => {
      rejected = true;
    });
    await flush(20);
    // Item 1 failed; item 0 is still running, so the call has not rejected yet and nothing new started.
    expect(started).toEqual([0, 1]);
    expect(rejected).toBe(false);
    slow.resolve();
    await expect(promise).rejects.toThrow('first failure');
    expect(settled.sort()).toEqual([0, 1]);
    expect(started).toEqual([0, 1]);
  });

  it('catches synchronous throws from fn', async () => {
    const fn = ((x: number) => {
      if (x === 2) throw new Error('sync');
      return Promise.resolve(x);
    }) as (x: number) => Promise<number>;
    await expect(mapLimit([1, 2, 3], 2, fn)).rejects.toThrow('sync');
  });

  it('does not produce unhandled rejections when several tasks fail', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(
        mapLimit([1, 2, 3, 4], 4, async (x) => {
          await sleep(x);
          throw new Error(`fail ${x}`);
        }),
      ).rejects.toThrow('fail 1');
      await sleep(20);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('sleep', () => {
  it('resolves after the given time', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = sleep(1000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });

  it('uses an unref’d timer', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await sleep(1);
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
  });

  it('treats negative / NaN delays as 0 and clamps huge ones', async () => {
    await sleep(-10);
    await sleep(Number.NaN);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const p = sleep(Number.MAX_SAFE_INTEGER);
    expect(spy.mock.calls[0]?.[1]).toBe(2_147_483_647);
    clearTimeout(spy.mock.results[0]?.value as NodeJS.Timeout);
    void p;
  });
});
