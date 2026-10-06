/**
 * Link API HTTP routes (served by the same HTTP server as /health).
 * STUB — to be implemented. Keep the exported API exactly as declared.
 *
 * ENDPOINT CONTRACT (single source of truth — INTEGRATION.md documents exactly this):
 * Base: <PUBLIC_URL>/api/v1. Every response is JSON (`content-type: application/json; charset=utf-8`).
 * Errors: `{ "error": { "code": "<snake_case>", "message": "<human text>" } }` with a fitting status.
 *
 * Auth: `Authorization: Bearer swb_…` (also accepted: `X-Link-Token: swb_…`). Tokens come from Discord `/link create`
 *   and are bound to one guild + one alert channel (store.findLinkToken). Missing/unknown → 401 `unauthorized`.
 *   Successful auth → store.touchLinkToken (at most once a minute per token).
 * CORS (for the extension's background worker / pages): every /api/v1 response carries
 *   Access-Control-Allow-Origin: *, Access-Control-Allow-Headers: Authorization, Content-Type, X-Link-Token,
 *   Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS, Access-Control-Max-Age: 600. OPTIONS → 204, no auth.
 * Limits per token (in-memory token buckets): 120 requests/min overall; POST /scan 20 per 10 min; POST /watches 30/hour.
 *   Exceeded → 429 `rate_limited` + Retry-After (seconds). Request bodies: JSON, ≤ 32 KB (413 `too_large`);
 *   invalid JSON → 400 `bad_request`. Unknown route → 404 `not_found`; wrong method → 405 `method_not_allowed`.
 *
 * GET    /api/v1/ping                → 200 { ok: true, bot: "site-watcher", version, apiVersion: 1,
 *                                            guild: { id }, channelId, label, watches: <count in guild> }
 * POST   /api/v1/scan                  body { url, subdomains?: "none"|"quick"|"full" }
 *                                     → 200 ScanResult (src/link/types.ts); bad url → 400 `invalid_url`;
 *                                       scan failure → 502 `scan_failed`.
 * GET    /api/v1/watches[?url=<u>]     → 200 { watches: ApiWatch[] } (guild's watches; with ?url= only those whose
 *                                       normalized url or host matches, plus `watched: boolean`).
 * POST   /api/v1/watches               body { url, name?, intervalSec?, features?: { deploy?, text?, pages?, subdomains?,
 *                                       files?, status?, codeIntel? } }
 *                                     → 201 { created: true, watch } — the site is added to the token's guild/channel,
 *                                       its silent first scan (monitor.runBaseline, then monitor.onWatchAdded) runs in the
 *                                       background (status "scanning" until done), and Discord gets
 *                                       "➕ **<name>** (<url>) was added from **<label>** — first scan running…"
 *                                       (via deps.announce) and, when the scan finishes, "✅ Now watching **<name>** …".
 *                                     → 200 { created: false, watch } if the guild already watches that URL.
 *                                     → 400 `invalid_url` / `invalid_interval`; 409 `limit_reached` (MAX_WATCHES_PER_GUILD).
 *                                       Name defaults like /watch add (parseWatchInput().suggestedName, made unique);
 *                                       interval defaults to config.defaultIntervalSec, clamped to [minIntervalSec, 3600].
 * GET    /api/v1/watches/:id           → 200 { watch: ApiWatch, events: ApiEvent[] (newest 20) }; other guild/unknown → 404.
 * DELETE /api/v1/watches/:id           → 200 { deleted: true } (store.deleteWatch + monitor.onWatchRemoved; Discord gets
 *                                       "➖ **<name>** was removed from **<label>**").
 * POST   /api/v1/watches/:id/check     → 200 { alerts: <n>, kinds: string[], error: string|null } (monitor.checkNow,
 *                                       max 60 s → 504 `timeout`).
 * GET    /api/v1/events?since=<id>&limit=<1..200, default 50>
 *                                     → 200 { events: ApiEvent[] (oldest first, id > since), nextSince: <last id or since> }
 *                                       — clients poll this to mirror alerts.
 */
import type http from 'node:http';
import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import type { Monitor } from '../monitor/scheduler.js';
import type { Logger } from '../types.js';
import type { ScanDeps } from './scan.js';

export interface LinkApiDeps {
  store: Store;
  config: Config;
  log: Logger;
  getMonitor: () => Monitor | null;
  scan: Omit<ScanDeps, 'store' | 'config' | 'log'>;
  /** Posts a one-line notice in Discord (e.g. "➕ Unpeg added from the extension"); resolves even if Discord is down. */
  announce?: (channelId: string, content: string) => Promise<void>;
  /** Test seam: replaces scanSite. */
  scanFn?: typeof import('./scan.js').scanSite;
  now?: () => number;
}

/**
 * Returns a request handler for everything under LINK_API_PREFIX; it returns false for other paths so the caller can
 * fall through (to /health). See INTEGRATION.md for the endpoint contract.
 */
export function createLinkApi(deps: LinkApiDeps): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
  throw new Error('not implemented');
}
