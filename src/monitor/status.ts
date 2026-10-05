/**
 * Up/down status tracking for the start URL.
 */

import type { InfoAlert, StatusAlert, WatchState } from '../types.js';
import type { FetchResult } from '../net/http.js';
import type { CheckContext } from './context.js';

/** Consecutive failed ticks before a DOWN alert. */
export const DOWN_AFTER_FAILURES = 3;
/** ...and the outage must also have lasted this long, so fast intervals (2s) don't turn a brief blip into a DOWN alert. */
export const DOWN_MIN_MS = 20_000;
/** Consecutive blocked (bot challenge) ticks before a one-time info alert. */
export const BLOCKED_AFTER = 3;
/**
 * Minimum time between two "bot challenge" info alerts for one watch. A challenge that comes and goes (e.g. Cloudflare
 * challenging only some requests) would otherwise re-arm and re-send the alert every few ticks.
 */
export const BLOCKED_REALERT_MS = 6 * 3600_000;

/** In-memory (per scheduler WatchState object) time of the last blocked / rate-limited info alert. */
const lastBlockedAlert = new WeakMap<WatchState, number>();
/** A "blocked" note was actually posted for the current episode → post a "reachable again" note when it ends. */
const blockedAnnounced = new WeakSet<WatchState>();

/** While a site keeps challenging/rate-limiting the watcher, its homepage is only probed this often. */
export const BLOCKED_PROBE_MS = 60_000;

/** True while the watch is in a bot-challenge or rate-limit episode (checks back off to BLOCKED_PROBE_MS). */
export function isWalledOff(state: Pick<WatchState, 'status'> | null | undefined): boolean {
  const st = state?.status;
  return !!st && ((st.consecutiveBlocked ?? 0) >= BLOCKED_AFTER || (st.consecutiveRateLimited ?? 0) >= BLOCKED_AFTER);
}

function protectionName(res: FetchResult): string {
  const h = res.headers ?? {};
  if (h['cf-ray'] || h['cf-mitigated'] || /cloudflare/i.test(h['server'] ?? '')) return 'Cloudflare';
  if (h['x-vercel-id'] || h['x-vercel-mitigated'] || /vercel/i.test(h['server'] ?? '')) return 'Vercel';
  if (h['x-amzn-waf-action']) return 'AWS WAF';
  return 'bot protection';
}
const lastRateLimitAlert = new WeakMap<WatchState, number>();

/** Human-readable failure detail for a FetchResult ("HTTP 503", "timeout after 20s", "ECONNREFUSED"). */
export function failureDetail(res: FetchResult): string {
  if (!res || typeof res !== 'object') return 'unknown error';
  const status = typeof res.status === 'number' && Number.isFinite(res.status) ? res.status : 0;
  if (status <= 0) {
    const err = typeof res.error === 'string' ? res.error.replace(/\s+/g, ' ').trim() : '';
    return err ? err.slice(0, 200) : 'unreachable';
  }
  if (res.blocked) return `bot challenge (HTTP ${status})`;
  return `HTTP ${status}`;
}

function isFailure(res: FetchResult): boolean {
  const status = typeof res.status === 'number' && Number.isFinite(res.status) ? res.status : 0;
  return status <= 0 || status >= 500;
}

/**
 * Update ctx.state.status from the homepage fetch and return alerts (never in baseline mode, but state still updates).
 * - Failure = status 0 (network error/timeout) or status >= 500 (and not `blocked`). 4xx counts as UP (site is serving).
 * - blocked (challenge page) → neither up nor down: consecutiveBlocked++ ; after BLOCKED_AFTER, one InfoAlert
 *   "⚠️ <host> is showing a bot challenge (Cloudflare/captcha) to the watcher — changes may be missed." (alertedBlocked=true).
 *   First unblocked fetch resets consecutiveBlocked/alertedBlocked (no alert).
 * - On failure: consecutiveFailures++, lastError = detail ("HTTP 502" / fetch.error); when it reaches DOWN_AFTER_FAILURES and
 *   features.status and !alertedDown → StatusAlert{up:false}; set downSince (time of FIRST failure of the streak), alertedDown=true, up=false.
 * - On success after alertedDown → StatusAlert{up:true, downForMs: now - downSince}. Reset counters, up=true, downSince=null.
 * - Success without prior alert → just reset counters.
 * - features.status=false → update state but never return StatusAlerts (blocked info alert still allowed).
 *
 * Implementation notes:
 * - downSince is recorded at the first failure of a streak (so the outage start survives restarts); `up` only turns false at
 *   the DOWN threshold. lastError is cleared on success.
 * - alertedDown / alertedBlocked are only set when the alert is actually returned, so a threshold crossed during a baseline
 *   pass (or with features.status off) still alerts on the next eligible tick. A recovery seen during a baseline pass leaves
 *   the outage state untouched so the next normal tick sends the UP alert.
 * - Blocked info alerts are additionally rate-limited in memory to one per BLOCKED_REALERT_MS per watch.
 * - HTTP 429 (the site rate-limits the watcher) is neither up nor down either: consecutiveRateLimited++, and after
 *   BLOCKED_AFTER such checks one info alert says checks are slowed down (re-armed once a check is not rate limited,
 *   throttled like the blocked alert). The HttpClient backs off from the host meanwhile.
 */
export function updateStatus(ctx: CheckContext, home: FetchResult): Array<StatusAlert | InfoAlert> {
  const alerts: Array<StatusAlert | InfoAlert> = [];
  if (!home || typeof home !== 'object') return alerts;
  const { watch, state } = ctx;
  const st = state.status;
  const now = ctx.now();
  const canAlert = !ctx.baseline;
  const statusAlerts = canAlert && watch.features.status;

  if (home.blocked) {
    st.consecutiveBlocked = (st.consecutiveBlocked > 0 ? st.consecutiveBlocked : 0) + 1;
    if (st.consecutiveBlocked >= BLOCKED_AFTER && !st.alertedBlocked && canAlert) {
      st.alertedBlocked = true;
      const last = lastBlockedAlert.get(state);
      if (last === undefined || now - last >= BLOCKED_REALERT_MS) {
        lastBlockedAlert.set(state, now);
        blockedAnnounced.add(state);
        const every = Math.max(watch.intervalSec, BLOCKED_PROBE_MS / 1000);
        alerts.push({
          kind: 'info',
          message:
            `🛡️ ${watch.host} is blocking the watcher with its ${protectionName(home)} bot check, so page, deploy and API checks are paused. ` +
            `Checking once every ${every >= 60 ? `${Math.round(every / 60)} min` : `${every}s`} until it lets the bot back in; subdomain alerts keep working.`,
        });
      }
    }
    return alerts;
  }

  if (blockedAnnounced.has(state) && st.consecutiveBlocked > 0) {
    blockedAnnounced.delete(state);
    if (canAlert) {
      alerts.push({ kind: 'info', message: `✅ ${watch.host} is letting the watcher in again — back to checking every ${watch.intervalSec}s.` });
    }
  }
  st.consecutiveBlocked = 0;
  st.alertedBlocked = false;

  if (home.status === 429) {
    st.consecutiveRateLimited = (st.consecutiveRateLimited > 0 ? st.consecutiveRateLimited : 0) + 1;
    if (st.consecutiveRateLimited >= BLOCKED_AFTER && !st.alertedRateLimited && canAlert) {
      st.alertedRateLimited = true;
      const last = lastRateLimitAlert.get(state);
      if (last === undefined || now - last >= BLOCKED_REALERT_MS) {
        lastRateLimitAlert.set(state, now);
        alerts.push({
          kind: 'info',
          message: `⚠️ ${watch.host} is rate-limiting the watcher (HTTP 429); checks are slowed down and changes may arrive late.`,
        });
      }
    }
    return alerts;
  }
  st.consecutiveRateLimited = 0;
  st.alertedRateLimited = false;

  if (isFailure(home)) {
    const detail = failureDetail(home);
    const failures = st.consecutiveFailures > 0 ? st.consecutiveFailures : 0;
    if (failures === 0 && !st.alertedDown) st.downSince = now;
    else if (st.downSince === null) st.downSince = now;
    st.consecutiveFailures = failures + 1;
    st.lastError = detail;
    const outageMs = st.downSince !== null && Number.isFinite(st.downSince) ? now - st.downSince : 0;
    if (st.consecutiveFailures >= DOWN_AFTER_FAILURES && (st.alertedDown || outageMs >= DOWN_MIN_MS)) {
      st.up = false;
      if (!st.alertedDown && statusAlerts) {
        st.alertedDown = true;
        alerts.push({ kind: 'status', url: watch.url, up: false, detail, downForMs: null });
      }
    }
    return alerts;
  }

  // Serving (any HTTP status below 500, including 4xx and 304).
  if (st.alertedDown && ctx.baseline) return alerts;
  if (st.alertedDown && statusAlerts) {
    const downForMs = st.downSince !== null && Number.isFinite(st.downSince) ? Math.max(0, now - st.downSince) : null;
    alerts.push({ kind: 'status', url: watch.url, up: true, detail: failureDetail(home), downForMs });
  }
  st.up = true;
  st.consecutiveFailures = 0;
  st.downSince = null;
  st.alertedDown = false;
  st.lastError = null;
  return alerts;
}
