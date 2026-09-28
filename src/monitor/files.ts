/**
 * Linked-document change detection (pdf, txt, md, docx, ...).
 *
 * File rows (PageRecord kind='file') are CREATED by the pages checker (links classified 'file' that are same-site —
 * any host under rootDomain, not just watch.host) with textHash=null. This module only fetches & compares them.
 *
 * Column usage for file rows: textHash = content hash, contentLength = size in bytes (decoded body; the Content-Length header
 * for truncated bodies), flapCount = consecutive "differs on every request" observations, dynamic = too volatile to alert on,
 * numericChangeTimes = times of recent confirmed changes (churn detection). `text` stays null.
 */

import type { FileAlert, PageRecord } from '../types.js';
import type { FetchResult } from '../net/http.js';
import { looksLikeHtml } from '../extract/html.js';
import { sha1 } from '../diff/text.js';
import { mapLimit } from '../net/limiter.js';
import type { CheckContext } from './context.js';

/** Max files fetched per call (keeps ticks bounded). */
export const MAX_FILES_PER_TICK = 10;
/** Max files fetched by one full check; the rest are checked by later calls (never-checked and least recently checked first). */
export const MAX_TRACKED_FILES = 100;

/** Consecutive 404/410 checks before a file counts as removed. */
export const REMOVE_AFTER_MISSES = 2;
/** Misses closer together than this count once (a deploy-triggered full sweep right after a normal check must not confirm a removal). */
export const REMOVAL_MIN_GAP_MS = 60_000;
/** Removed files are re-checked this often (a file can come back, or a dead link can finally get its file). */
export const GONE_RECHECK_MS = 60 * 60_000;
/** Files judged dynamic are re-checked at most this often. */
export const DYNAMIC_RECHECK_MS = 60 * 60_000;
/** Consecutive "different bytes on every request" observations before a file is judged dynamic. */
export const DYNAMIC_AFTER_FLAPS = 3;
/** Confirmed changes within CHURN_WINDOW_MS that make a file dynamic (live data files would otherwise alert every sweep). */
export const CHURN_LIMIT = 3;
export const CHURN_WINDOW_MS = 60 * 60_000;
/** A dynamic file that stays unchanged this long is trusted again. */
export const DYNAMIC_RESET_MS = 24 * 3600_000;

const FILE_CONCURRENCY = 2;
/** Wall-clock budget for starting file fetches in one call. Files not reached stay due for the next tick. */
const CALL_BUDGET_MS = 90_000;
const MAX_CHANGE_TIMES = 20;

type FileEntry = FileAlert['files'][number];

interface Snapshot {
  hash: string;
  size: number | null;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
}

function header(res: FetchResult, name: string): string | null {
  const v = res.headers?.[name];
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 1024) : null;
}

/**
 * Content identity of a 2xx response. Complete bodies hash their bytes. A body cut at maxFileBytes hashes the prefix plus
 * the declared length: deterministic for an unchanged file, and immune to validators (ETag/Last-Modified) that change on every
 * redeploy or differ between cluster nodes although the bytes do not.
 */
function snapshot(res: FetchResult): Snapshot {
  const body = res.body ?? Buffer.alloc(0);
  const declared = header(res, 'content-length');
  let hash: string;
  let size: number | null;
  if (res.truncated) {
    hash = sha1(`len:${declared ?? ''}|prefix:${sha1(body)}`);
    const n = declared !== null ? Number(declared) : NaN;
    size = Number.isSafeInteger(n) && n >= 0 ? n : null;
  } else {
    hash = sha1(body);
    size = body.length;
  }
  return { hash, size, etag: header(res, 'etag'), lastModified: header(res, 'last-modified'), contentType: res.contentType };
}

/** A document URL answered with an HTML page (SPA fallback / soft 404) — its bytes say nothing about the file. */
function isSoft404(res: FetchResult): boolean {
  return res.ok && looksLikeHtml(res.contentType, res.bodyText);
}

function isMissing(res: FetchResult): boolean {
  return res.status === 404 || res.status === 410 || isSoft404(res);
}

function applySnapshot(r: PageRecord, s: Snapshot, withHash: boolean): void {
  if (withHash) r.textHash = s.hash;
  r.etag = s.etag;
  r.lastModified = s.lastModified;
  r.contentLength = s.size;
  r.contentType = s.contentType;
}

function isDue(r: PageRecord, now: number, sweepMs: number, full: boolean): boolean {
  const since = now - (Number.isFinite(r.lastChecked) ? r.lastChecked : 0);
  if (r.gone) return full || since >= GONE_RECHECK_MS;
  if (r.dynamic) return since >= Math.max(sweepMs, DYNAMIC_RECHECK_MS);
  return full || r.lastChecked <= 0 || since >= sweepMs;
}

/** Unchanged check of a dynamic file: trust it again after DYNAMIC_RESET_MS without changes. */
function maybeTrustAgain(r: PageRecord, now: number): void {
  if (!r.dynamic) return;
  const since = r.lastChanged ?? r.firstSeen ?? 0;
  if (now - since >= DYNAMIC_RESET_MS) {
    r.dynamic = false;
    r.flapCount = 0;
    r.numericChangeTimes = [];
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Real documents (a whitepaper, an audit) rank before text/markdown files when not all due files fit one call. */
const DOCUMENT_EXT_RE = /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|epub|rtf|csv|key|pages|numbers)$/i;

function isDocument(url: string): boolean {
  try {
    return DOCUMENT_EXT_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Order due files: never checked first (a newly linked file is reported promptly), then least recently checked; documents first on ties. */
function byPriority(a: PageRecord, b: PageRecord): number {
  const neverA = a.lastChecked <= 0 || a.textHash === null ? 0 : 1;
  const neverB = b.lastChecked <= 0 || b.textHash === null ? 0 : 1;
  if (neverA !== neverB) return neverA - neverB;
  const docA = isDocument(a.url) ? 0 : 1;
  const docB = isDocument(b.url) ? 0 : 1;
  if (neverA === 0 && docA !== docB) return docA - docB;
  if (a.lastChecked !== b.lastChecked) return a.lastChecked - b.lastChecked;
  if (docA !== docB) return docA - docB;
  return a.firstSeen - b.firstSeen || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
}

/** A baseline, or a silent pass after a settings change: file changes are recorded without alerting. */
function quiet(ctx: CheckContext): boolean {
  return Boolean(ctx.baseline || ctx.silent?.files || ctx.silent?.discovery);
}

function cancelled(ctx: CheckContext): boolean {
  try {
    return ctx.cancelled?.() === true;
  } catch {
    return false;
  }
}

/**
 * Check one file. Returns the alert entry (if any). The stored row is re-read after the fetch so concurrent edits of other
 * columns are kept, and validators are only stored together with the hash of the content they describe (otherwise a later 304
 * would hide a change forever).
 */
async function checkOne(ctx: CheckContext, rec: PageRecord): Promise<FileEntry | null> {
  const { store, watch, config } = ctx;
  const fetchOpts = { maxBytes: config.maxFileBytes, accept: '*/*' };
  const res = await ctx.http.fetch(rec.url, {
    ...fetchOpts,
    etag: rec.textHash ? rec.etag : null,
    lastModified: rec.textHash ? rec.lastModified : null,
  });

  const fresh = store.getPage(watch.id, rec.url);
  if (!fresh || fresh.kind !== 'file') return null;
  const now = ctx.now();
  const prevChecked = fresh.lastChecked;
  const r: PageRecord = { ...fresh, numericChangeTimes: [...(fresh.numericChangeTimes ?? [])] };
  r.lastChecked = now;
  r.status = res.status;
  let entry: FileEntry | null = null;

  try {
    if (res.notModified) {
      r.failCount = 0;
      r.gone = false;
      maybeTrustAgain(r, now);
    } else if (isMissing(res)) {
      if (r.failCount <= 0 || now - prevChecked >= REMOVAL_MIN_GAP_MS) r.failCount = Math.max(0, r.failCount) + 1;
      if (r.failCount >= REMOVE_AFTER_MISSES && !r.gone) {
        r.gone = true;
        // Never announce the removal of something we never saw (a dead link from the start).
        if (r.textHash !== null && !quiet(ctx)) {
          entry = { url: r.url, change: 'removed', oldSize: r.contentLength, newSize: null, contentType: r.contentType };
        }
      }
    } else if (res.ok && !res.blocked) {
      entry = await onContent(ctx, r, fresh, res, now);
    }
    // Anything else (status 0, 5xx, 3xx loops, challenges, 401/403/429...) says nothing about the file: only lastChecked/status.
  } finally {
    store.upsertPage(r);
  }
  if (entry) ctx.state.lastChangeAt = now;
  return entry;
}

async function onContent(
  ctx: CheckContext,
  r: PageRecord,
  fresh: PageRecord,
  res: FetchResult,
  now: number,
): Promise<FileEntry | null> {
  const snap = snapshot(res);
  const wasGone = fresh.gone;
  const previouslyMissing = wasGone || fresh.failCount > 0;
  // It is being served again; `gone` is only cleared once content is accepted (an unconfirmed change keeps it removed).
  r.failCount = 0;

  // First content ever (or a dead link that finally has a file).
  if (r.textHash === null) {
    r.gone = false;
    applySnapshot(r, snap, true);
    r.lastChanged = now;
    const isNew = !quiet(ctx) && (r.firstSeen > ctx.state.baselineAt || previouslyMissing);
    return isNew ? { url: r.url, change: 'added', oldSize: null, newSize: snap.size, contentType: snap.contentType } : null;
  }

  if (snap.hash === r.textHash) {
    // Same bytes; validators may still have changed (weak ETags, touched mtimes).
    r.gone = false;
    applySnapshot(r, snap, false);
    maybeTrustAgain(r, now);
    return null;
  }

  // Re-baseline, or a file too volatile to report: record silently.
  if (quiet(ctx) || r.dynamic) {
    r.gone = false;
    applySnapshot(r, snap, true);
    r.lastChanged = now;
    return null;
  }

  // Candidate change: confirm with a second, unconditional fetch.
  await ctx.sleep(Math.max(0, ctx.config.confirmDelayMs));
  const res2 = await ctx.http.fetch(r.url, { maxBytes: ctx.config.maxFileBytes, accept: '*/*' });
  if (!res2.ok || res2.blocked || isSoft404(res2)) return null;
  const snap2 = snapshot(res2);
  if (snap2.hash === r.textHash) {
    // Mixed CDN edges / rolling deploy: the old version is still being served.
    ctx.log.debug('file change transient', { watch: ctx.watch.id, url: r.url });
    return null;
  }
  if (snap2.hash !== snap.hash) {
    r.flapCount = Math.max(0, r.flapCount) + 1;
    if (r.flapCount >= DYNAMIC_AFTER_FLAPS && !r.dynamic) {
      r.dynamic = true;
      ctx.log.info('file differs on every request; no longer alerting on it', { watch: ctx.watch.id, url: r.url });
    }
    return null;
  }

  const oldSize = r.contentLength;
  r.gone = false;
  r.flapCount = 0;
  applySnapshot(r, snap2, true);
  r.lastChanged = now;
  const recent = r.numericChangeTimes.filter((t) => Number.isFinite(t) && now - t < CHURN_WINDOW_MS);
  recent.push(now);
  r.numericChangeTimes = recent.slice(-MAX_CHANGE_TIMES);
  if (recent.length >= CHURN_LIMIT) {
    r.dynamic = true;
    ctx.log.info('file changes too often; no longer alerting on it', { watch: ctx.watch.id, url: r.url, changes: recent.length });
  }
  if (wasGone) {
    return { url: r.url, change: 'added', oldSize, newSize: snap2.size, contentType: snap2.contentType };
  }
  return { url: r.url, change: 'modified', oldSize, newSize: snap2.size, contentType: snap2.contentType };
}

/**
 * Check due file records (tracked kind='file', not gone):
 * - Due if `full` or now - lastChecked >= watch.sweepSec*1000. Never-checked files first (documents before text/markdown),
 *   then oldest lastChecked, at most MAX_FILES_PER_TICK (full: MAX_TRACKED_FILES) per call — so every tracked file is
 *   reached in rotation, however many there are.
 * - GET with If-None-Match/If-Modified-Since from the record (maxBytes: config.maxFileBytes, accept "*\/*").
 *   304 → unchanged (update lastChecked). 404/410 → failCount++; at 2 → gone=true and 'removed' entry. Other non-2xx/status 0 → ignore (update lastChecked only).
 *   2xx → hash = truncated ? sha1(`len:${content-length}|etag:${etag}|lm:${last-modified}`) : sha1(body).
 *     textHash null (first successful fetch) → if !ctx.baseline && record.firstSeen > ctx.state.baselineAt → 'added' entry;
 *       otherwise store silently.
 *     hash changed → 'modified' entry with oldSize/newSize (contentLength before/after).
 *   Always persist etag/lastModified/contentLength/contentType/status/lastChecked; set lastChanged on change.
 * - Return one FileAlert with all entries (or [] if none / baseline / features.files false).
 *
 * Implementation notes (noise control):
 * - A changed hash is confirmed by an unconditional re-fetch: the old bytes again → transient (mixed CDN edges); different
 *   bytes again → the file changes per request (flapCount; dynamic after DYNAMIC_AFTER_FLAPS). Unconfirmed changes keep the
 *   old hash AND validators.
 * - Truncated bodies hash the received prefix + Content-Length instead of ETag/Last-Modified (see `snapshot`).
 * - CHURN_LIMIT confirmed changes within CHURN_WINDOW_MS mark the file dynamic (the triggering change is still reported);
 *   dynamic files are checked hourly, never alerted, and trusted again after DYNAMIC_RESET_MS without changes.
 * - An HTML answer for a document URL (SPA fallback / soft 404) counts like a 404. Misses less than REMOVAL_MIN_GAP_MS apart
 *   count once, and a file whose content was never seen is marked gone silently (a dead link is not a removal).
 * - Removed (gone) files are re-checked every GONE_RECHECK_MS (and on full sweeps): a dead link that gets its file, or a
 *   removed file that returns with different content, is reported as 'added'; one that returns unchanged is restored silently.
 * - ctx.silent.files / .discovery (a settings change) records like a baseline; ctx.cancelled() stops starting fetches.
 */
export async function checkFiles(ctx: CheckContext, opts: { full: boolean }): Promise<FileAlert[]> {
  const { watch, store } = ctx;
  if (!watch.features.files) return [];
  const full = Boolean(opts?.full);

  let records: PageRecord[];
  try {
    records = store.listPages(watch.id, { kind: 'file', tracked: true });
  } catch (err) {
    ctx.log.warn('listing files failed', { watch: watch.id, err: errText(err) });
    return [];
  }
  if (records.length === 0) return [];

  const now = ctx.now();
  const sweepMs = Math.max(1, Number.isFinite(watch.sweepSec) ? watch.sweepSec : 120) * 1000;
  const due = records.filter((r) => isDue(r, now, sweepMs, full)).sort(byPriority);
  const batch = due.slice(0, full ? MAX_TRACKED_FILES : MAX_FILES_PER_TICK);

  const entries: FileEntry[] = [];
  const deadline = Date.now() + CALL_BUDGET_MS;
  await mapLimit(batch, FILE_CONCURRENCY, async (rec) => {
    if (Date.now() > deadline || cancelled(ctx)) return;
    try {
      const entry = await checkOne(ctx, rec);
      if (entry) entries.push(entry);
    } catch (err) {
      ctx.log.warn('file check failed', { watch: watch.id, url: rec.url, err: errText(err) });
    }
  });

  if (quiet(ctx) || entries.length === 0) return [];
  const order = { added: 0, modified: 1, removed: 2 } as const;
  entries.sort((a, b) => order[a.change] - order[b.change] || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return [{ kind: 'file', files: entries }];
}
