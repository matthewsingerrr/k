/**
 * API tracking: GET-able JSON endpoints referenced in the site's own code (e.g. "/api/launches/count") are probed once and,
 * when they answer with JSON, tracked like pages — so a change in what the API returns is posted as a JSON diff.
 * Endpoints added later in a redeploy reach the page checker as new code paths and are announced as new pages.
 */

import { inScope, normalizeUrl } from '../extract/url.js';
import { jsonLines, looksLikeJson } from '../extract/json.js';
import type { InfoAlert, PageRecord } from '../types.js';
import type { CheckContext } from './context.js';

/** Probes per check (keeps a tick bounded; the rest are probed on later checks). */
export const MAX_API_PROBES_PER_TICK = 3;
/** API endpoints auto-tracked per site. */
export const MAX_API_ENDPOINTS = 15;
const MAX_PROBED_REMEMBERED = 500;

/** Route-like code paths that look like plain GET-able API endpoints (no templated segments). */
export function apiCandidates(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || p.length > 120 || p.endsWith('/')) continue;
    if (!/(^|\/)api(\/|$)/i.test(p)) continue;
    if (/[[\]{}:*$<>]/.test(p)) continue;
    if (/\/(auth|login|logout|signin|signout|session|callback|webhook|upload|admin)(\/|$)/i.test(p)) continue;
    out.push(p);
  }
  return out;
}

function isApiRecord(r: PageRecord): boolean {
  try {
    return r.source === 'code' && /(^|\/)api(\/|$)/i.test(new URL(r.url).pathname);
  } catch {
    return false;
  }
}

function newRecord(watchId: number, url: string, contentType: string | null, now: number): PageRecord {
  return {
    watchId, url, kind: 'page', tracked: true, title: null, text: null, textHash: null, etag: null, lastModified: null,
    contentLength: null, contentType, status: 200, failCount: 0, gone: false, maskNumbers: false, maskedLines: [],
    numericChangeTimes: [], flapCount: 0, dynamic: false, pendingHash: null, pendingSince: null, hashHistory: [], changeTimes: [],
    source: 'code', depth: 1, firstSeen: now, lastChecked: 0, lastChanged: null,
  };
}

/**
 * Probe not-yet-tried API paths from ctx.state.codePaths. Endpoints answering 2xx JSON become tracked pages whose first
 * check records their content silently; the next changes produce normal text alerts with a JSON diff.
 * Returns a one-time info listing newly tracked endpoints (none during a baseline).
 */
export async function probeApiEndpoints(ctx: CheckContext): Promise<InfoAlert[]> {
  const { watch, state, store } = ctx;
  if (!watch.features.text) return [];
  const tried = new Set(Array.isArray(state.apiProbed) ? state.apiProbed : []);
  const pages = store.listPages(watch.id, { kind: 'page', tracked: true });
  let apiCount = pages.filter(isApiRecord).length;
  let room = Math.min(MAX_API_ENDPOINTS - apiCount, watch.maxPages - pages.filter((r) => !r.gone).length);
  if (room <= 0) return [];
  let origin: string;
  try {
    origin = new URL(watch.url).origin;
  } catch {
    return [];
  }
  const added: string[] = [];
  let probes = 0;
  for (const path of apiCandidates(state.codePaths ?? [])) {
    if (probes >= MAX_API_PROBES_PER_TICK || room <= 0 || ctx.cancelled?.()) break;
    if (tried.has(path)) continue;
    const url = normalizeUrl(origin + path);
    if (!url || !inScope(url, watch) || store.getPage(watch.id, url)) {
      tried.add(path);
      continue;
    }
    probes++;
    const res = await ctx.http.fetch(url, { accept: 'application/json, */*;q=0.5', retries: 0 });
    // Transient answers are retried on a later check; anything definitive is remembered.
    if (res.blocked || res.status === 0 || res.status === 429 || res.status >= 500) continue;
    tried.add(path);
    if (!res.ok || typeof res.bodyText !== 'string' || !looksLikeJson(res.contentType, res.bodyText) || !jsonLines(res.bodyText)) continue;
    store.upsertPage(newRecord(watch.id, url, res.contentType, ctx.now()));
    added.push(path);
    apiCount++;
    room--;
  }
  state.apiProbed = [...tried].slice(-MAX_PROBED_REMEMBERED);
  if (!added.length || ctx.baseline) return [];
  const list = added.map((p) => `\`${p}\``).join(', ');
  return [
    {
      kind: 'info',
      message: `🔌 Now tracking ${added.length === 1 ? 'an API endpoint' : `${added.length} API endpoints`} found in ${watch.host}'s code: ${list}. Changes in what ${added.length === 1 ? 'it returns' : 'they return'} will be posted as a diff.`,
    },
  ];
}
