import { afterEach, describe, expect, it } from 'vitest';
import {
  BLOCKED_AFTER,
  BLOCKED_REALERT_MS,
  DOWN_AFTER_FAILURES,
  failureDetail,
  updateStatus,
} from '../src/monitor/status.js';
import type { InfoAlert, StatusAlert } from '../src/types.js';
import { fakeFetch, makeHarness, START_TIME, type Harness } from './helpers/core-monitor-harness.js';

const TICK = 30_000;
let harnesses: Harness[] = [];

function setup(opts: Parameters<typeof makeHarness>[0] = { url: 'https://unpeg.io/' }): Harness {
  const h = makeHarness(opts);
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses) h.close();
  harnesses = [];
});

const ok = () => fakeFetch(200);
const bad = (status = 502) => fakeFetch(status);
const netErr = (error = 'ECONNREFUSED') => fakeFetch(0, { error });
const blocked = () => fakeFetch(403, { blocked: true, bodyText: 'Just a moment...' });

/** Runs one tick (advancing the clock first) and returns its alerts. */
function tick(h: Harness, res: ReturnType<typeof fakeFetch>): Array<StatusAlert | InfoAlert> {
  h.advance(TICK);
  return updateStatus(h.ctx, res);
}

describe('failureDetail', () => {
  it('describes HTTP and network failures', () => {
    expect(failureDetail(fakeFetch(503))).toBe('HTTP 503');
    expect(failureDetail(fakeFetch(502))).toBe('HTTP 502');
    expect(failureDetail(fakeFetch(0, { error: 'timeout after 20s' }))).toBe('timeout after 20s');
    expect(failureDetail(fakeFetch(0, { error: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
    expect(failureDetail(fakeFetch(0, { error: null }))).toBe('unreachable');
    expect(failureDetail(fakeFetch(0, { error: '   ' }))).toBe('unreachable');
    expect(failureDetail(fakeFetch(403, { blocked: true }))).toBe('bot challenge (HTTP 403)');
    expect(failureDetail(fakeFetch(200))).toBe('HTTP 200');
  });

  it('never throws on junk', () => {
    expect(failureDetail(null as never)).toBe('unknown error');
    expect(failureDetail({ status: Number.NaN } as never)).toBe('unreachable');
  });
});

describe('updateStatus: down / up', () => {
  it(`alerts DOWN only after ${DOWN_AFTER_FAILURES} consecutive failures, once per outage`, () => {
    const h = setup();
    const st = h.ctx.state.status;
    expect(tick(h, bad())).toEqual([]);
    const firstFailureAt = h.clock.now;
    expect(st.downSince).toBe(firstFailureAt);
    expect(st.up).toBe(true);
    expect(tick(h, bad())).toEqual([]);
    expect(st.consecutiveFailures).toBe(2);

    const alerts = tick(h, bad(503));
    expect(alerts).toEqual([{ kind: 'status', url: 'https://unpeg.io/', up: false, detail: 'HTTP 503', downForMs: null }]);
    expect(st).toMatchObject({ up: false, alertedDown: true, consecutiveFailures: 3, lastError: 'HTTP 503', downSince: firstFailureAt });

    // Still down: no repeated alerts.
    expect(tick(h, netErr())).toEqual([]);
    expect(tick(h, netErr('timeout after 20s'))).toEqual([]);
    expect(st.consecutiveFailures).toBe(5);
    expect(st.lastError).toBe('timeout after 20s');
    expect(st.downSince).toBe(firstFailureAt);
  });

  it('alerts recovery with the outage duration and resets state', () => {
    const h = setup();
    tick(h, netErr());
    const firstFailureAt = h.clock.now;
    tick(h, netErr());
    tick(h, netErr());
    tick(h, bad());
    const alerts = tick(h, ok());
    expect(alerts).toEqual([
      { kind: 'status', url: 'https://unpeg.io/', up: true, detail: 'HTTP 200', downForMs: h.clock.now - firstFailureAt },
    ]);
    expect(alerts[0].kind === 'status' && alerts[0].downForMs).toBe(4 * TICK);
    expect(h.ctx.state.status).toMatchObject({
      up: true,
      consecutiveFailures: 0,
      downSince: null,
      alertedDown: false,
      lastError: null,
    });
    // A new outage is a new streak.
    expect(tick(h, bad())).toEqual([]);
    expect(h.ctx.state.status.downSince).toBe(h.clock.now);
  });

  it('resets silently when a streak ends before the threshold', () => {
    const h = setup();
    tick(h, bad());
    tick(h, bad());
    expect(tick(h, ok())).toEqual([]);
    expect(h.ctx.state.status).toMatchObject({ up: true, consecutiveFailures: 0, downSince: null, lastError: null });
    expect(tick(h, bad())).toEqual([]);
    expect(tick(h, bad())).toEqual([]);
    expect(tick(h, bad())).toHaveLength(1);
  });

  it('treats 4xx (and 3xx/304) as up: the site is serving', () => {
    const h = setup();
    for (let i = 0; i < 10; i++) expect(tick(h, fakeFetch([404, 403, 401, 429, 410][i % 5]))).toEqual([]);
    expect(h.ctx.state.status).toMatchObject({ up: true, consecutiveFailures: 0 });
    // A 4xx also ends a failure streak.
    tick(h, bad());
    tick(h, bad());
    tick(h, fakeFetch(404));
    expect(h.ctx.state.status.consecutiveFailures).toBe(0);
    tick(h, bad());
    tick(h, bad());
    expect(tick(h, fakeFetch(304))).toEqual([]);
    expect(h.ctx.state.status.consecutiveFailures).toBe(0);
  });

  it('counts 500 and status 0 as failures', () => {
    const h = setup();
    tick(h, fakeFetch(500));
    tick(h, netErr('ENOTFOUND'));
    const alerts = tick(h, netErr('blocked private address 10.0.0.1'));
    expect(alerts).toHaveLength(1);
    expect((alerts[0] as StatusAlert).detail).toBe('blocked private address 10.0.0.1');
  });
});

describe('updateStatus: bot challenge', () => {
  it(`sends one info alert after ${BLOCKED_AFTER} blocked ticks`, () => {
    const h = setup();
    const st = h.ctx.state.status;
    expect(tick(h, blocked())).toEqual([]);
    expect(tick(h, blocked())).toEqual([]);
    const alerts = tick(h, blocked());
    expect(alerts).toEqual([
      {
        kind: 'info',
        message: '⚠️ unpeg.io is showing a bot challenge (Cloudflare/captcha) to the watcher — changes may be missed.',
      },
    ]);
    expect(st).toMatchObject({ consecutiveBlocked: 3, alertedBlocked: true, up: true, consecutiveFailures: 0 });
    for (let i = 0; i < 5; i++) expect(tick(h, blocked())).toEqual([]);

    // First unblocked fetch resets the blocked flags without an alert.
    expect(tick(h, ok())).toEqual([]);
    expect(st).toMatchObject({ consecutiveBlocked: 0, alertedBlocked: false });
  });

  it('is neither up nor down: a challenge does not break or extend a failure streak', () => {
    const h = setup();
    tick(h, bad());
    tick(h, bad());
    tick(h, blocked());
    expect(h.ctx.state.status.consecutiveFailures).toBe(2);
    const alerts = tick(h, bad());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'status', up: false });
    // While down, challenges do not produce a recovery.
    expect(tick(h, blocked())).toEqual([]);
    expect(h.ctx.state.status.up).toBe(false);
  });

  it('rate-limits repeated challenge alerts when the challenge comes and goes', () => {
    const h = setup();
    const cycle = () => {
      const out: Array<StatusAlert | InfoAlert> = [];
      for (let i = 0; i < BLOCKED_AFTER; i++) out.push(...tick(h, blocked()));
      out.push(...tick(h, ok()));
      return out;
    };
    expect(cycle()).toHaveLength(1);
    for (let i = 0; i < 20; i++) expect(cycle()).toEqual([]);
    h.advance(BLOCKED_REALERT_MS);
    expect(cycle()).toHaveLength(1);
  });

  it('allows the challenge info alert even with features.status off', () => {
    const h = setup({ url: 'https://unpeg.io/', features: { status: false } });
    tick(h, blocked());
    tick(h, blocked());
    expect(tick(h, blocked())).toHaveLength(1);
  });
});

describe('updateStatus: features.status=false and baseline', () => {
  it('updates state but never returns status alerts when disabled', () => {
    const h = setup({ url: 'https://unpeg.io/', features: { status: false } });
    for (let i = 0; i < 6; i++) expect(tick(h, bad())).toEqual([]);
    expect(h.ctx.state.status).toMatchObject({ up: false, consecutiveFailures: 6, alertedDown: false, lastError: 'HTTP 502' });
    expect(tick(h, ok())).toEqual([]);
    expect(h.ctx.state.status).toMatchObject({ up: true, consecutiveFailures: 0, downSince: null });
  });

  it('alerts on the next failure if status alerts get enabled mid-outage', () => {
    const h = setup({ url: 'https://unpeg.io/', features: { status: false } });
    tick(h, bad());
    const firstFailureAt = h.clock.now;
    tick(h, bad());
    tick(h, bad());
    h.ctx.watch = { ...h.ctx.watch, features: { ...h.ctx.watch.features, status: true } };
    expect(tick(h, bad())).toHaveLength(1);
    const up = tick(h, ok());
    expect(up).toHaveLength(1);
    expect((up[0] as StatusAlert).downForMs).toBe(h.clock.now - firstFailureAt);
  });

  it('emits nothing in baseline mode but keeps counting', () => {
    const h = setup({ url: 'https://unpeg.io/', baseline: true });
    for (let i = 0; i < 4; i++) expect(tick(h, bad())).toEqual([]);
    for (let i = 0; i < 4; i++) expect(tick(h, blocked())).toEqual([]);
    expect(h.ctx.state.status).toMatchObject({ up: false, alertedDown: false, alertedBlocked: false, consecutiveBlocked: 4 });
    // The first normal tick that is still failing sends the DOWN alert.
    h.ctx.baseline = false;
    expect(tick(h, bad())).toHaveLength(1);
  });

  it('a recovery seen during a baseline pass is reported by the next normal tick', () => {
    const h = setup();
    tick(h, bad());
    const firstFailureAt = h.clock.now;
    tick(h, bad());
    expect(tick(h, bad())).toHaveLength(1);
    h.ctx.baseline = true;
    expect(tick(h, ok())).toEqual([]);
    h.ctx.baseline = false;
    const alerts = tick(h, ok());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'status', up: true, downForMs: h.clock.now - firstFailureAt });
  });

  it(`treats HTTP 429 as rate limited (neither up nor down): one info after ${BLOCKED_AFTER} checks, re-armed when it ends`, () => {
    const h = setup();
    const limited = () => fakeFetch(429, { retryAfterMs: 60_000 });
    tick(h, bad());
    tick(h, bad());
    const infos: string[] = [];
    for (let i = 0; i < 5; i++) {
      for (const a of tick(h, limited())) {
        expect(a.kind).toBe('info');
        infos.push((a as InfoAlert).message);
      }
    }
    expect(infos).toEqual(['⚠️ unpeg.io is rate-limiting the watcher (HTTP 429); checks are slowed down and changes may arrive late.']);
    // The failure streak was neither broken nor extended; up is unchanged.
    expect(h.ctx.state.status).toMatchObject({ up: true, consecutiveFailures: 2, consecutiveRateLimited: 5, alertedRateLimited: true });
    tick(h, ok());
    expect(h.ctx.state.status).toMatchObject({ consecutiveRateLimited: 0, alertedRateLimited: false });
  });

  it('starts from the default state', () => {
    const h = setup();
    expect(h.ctx.state.status).toMatchObject({ up: true, consecutiveFailures: 0, consecutiveBlocked: 0 });
    expect(h.clock.now).toBe(START_TIME);
    expect(updateStatus(h.ctx, null as never)).toEqual([]);
  });
});
