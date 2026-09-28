/**
 * Shared contracts for the whole bot. Every module codes against these types.
 * Keep this file dependency-free (types only, plus a few tiny constants).
 */

// ---------------------------------------------------------------------------
// Watches (a monitored site) & persisted state
// ---------------------------------------------------------------------------

export interface WatchFeatures {
  /** Detect redeploys (JS/CSS bundle hashes / build id changed). */
  deploy: boolean;
  /** Detect visible-text changes on tracked pages (with diffs). */
  text: boolean;
  /** Detect newly added / removed pages (links + sitemap). */
  pages: boolean;
  /** Detect new subdomains (CT logs, DNS wordlist, hostnames in site code). */
  subdomains: boolean;
  /** Detect changes to linked documents (pdf, txt, md, ...). */
  files: boolean;
  /** Alert when the site goes down / comes back up. */
  status: boolean;
  /** On redeploy, scan new JS bundles for newly referenced routes & hosts. */
  codeIntel: boolean;
}

export const DEFAULT_FEATURES: WatchFeatures = {
  deploy: true,
  text: true,
  pages: true,
  subdomains: true,
  files: true,
  status: true,
  codeIntel: true,
};

export interface Watch {
  id: number;
  guildId: string;
  channelId: string;
  /** Display name, e.g. "Unpeg". */
  name: string;
  /** Normalized start URL, e.g. "https://unpeg.io/". */
  url: string;
  /** Hostname of `url` (lowercase, no port), e.g. "unpeg.io". */
  host: string;
  /** Registrable domain used for subdomain discovery, e.g. "unpeg.io". For IPs / localhost this is the hostname itself. */
  rootDomain: string;
  /** Seconds between fast ticks (homepage/deploy/status + a slice of the page sweep). */
  intervalSec: number;
  /** Target seconds for every tracked page/file to be re-checked once (spread over ticks). */
  sweepSec: number;
  /** Max pages whose content is tracked (text diffs). Other discovered URLs are only "known". */
  maxPages: number;
  /** Role to ping on alerts (null = no ping). */
  pingRoleId: string | null;
  features: WatchFeatures;
  /** Regex sources (JS syntax, no slashes, flag "gi" applied) stripped from page text before comparing. */
  ignorePatterns: string[];
  /** Regex sources; URLs matching any are never crawled/tracked. */
  excludePatterns: string[];
  /** Extra absolute URLs to always track (e.g. unlinked pages). */
  extraUrls: string[];
  /** If set, only crawl URLs whose pathname starts with this prefix (e.g. "/docs"). null = whole host. */
  scopePath: string | null;
  /** Ignore number-only text changes on every page of this watch. */
  maskNumbers: boolean;
  paused: boolean;
  baselineDone: boolean;
  createdBy: string;
  createdAt: number;
}

export interface NewWatchInput {
  guildId: string;
  channelId: string;
  name: string;
  url: string;
  host: string;
  rootDomain: string;
  createdBy: string;
  intervalSec?: number;
  sweepSec?: number;
  maxPages?: number;
  pingRoleId?: string | null;
  features?: Partial<WatchFeatures>;
  ignorePatterns?: string[];
  excludePatterns?: string[];
  extraUrls?: string[];
  scopePath?: string | null;
  maskNumbers?: boolean;
}

/** Fields that may be changed after creation. `features` is merged over the existing flags (a partial patch is fine). */
export type WatchPatch = Partial<
  Pick<
    Watch,
    | 'url'
    | 'host'
    | 'channelId'
    | 'name'
    | 'intervalSec'
    | 'sweepSec'
    | 'maxPages'
    | 'pingRoleId'
    | 'ignorePatterns'
    | 'excludePatterns'
    | 'extraUrls'
    | 'scopePath'
    | 'maskNumbers'
    | 'paused'
    | 'baselineDone'
  >
> & { features?: Partial<WatchFeatures> };

export interface DeployFingerprint {
  /** Sorted, de-duplicated absolute URLs of same-site scripts/styles/preloads (excluding volatile ones like /cdn-cgi/). */
  assets: string[];
  /** Framework build id if detectable (Next.js pages/app router, Nuxt, Gatsby, SvelteKit, Astro, etc.). */
  buildId: string | null;
  /** <meta name="generator"> or x-powered-by, informational only. */
  generator: string | null;
  /** Stable signature = sha1 over (buildId + assets). Empty-asset sites with no buildId have sig "" (deploy detection disabled). */
  sig: string;
  seenAt: number;
}

export interface StatusState {
  up: boolean;
  consecutiveFailures: number;
  consecutiveBlocked: number;
  lastError: string | null;
  downSince: number | null;
  /** True once a DOWN alert was sent for the current outage. */
  alertedDown: boolean;
  /** True once a "bot is blocked" info alert was sent (reset when unblocked). */
  alertedBlocked: boolean;
  /** Consecutive homepage checks answered with HTTP 429 (rate limited): neither up nor down. */
  consecutiveRateLimited: number;
  /** True once a "rate limited" info alert was sent (reset when a check is not rate limited). */
  alertedRateLimited: boolean;
}

export interface WatchState {
  deploy: DeployFingerprint | null;
  /** Recent deploy signatures (newest last, max ~10) for flip-flop suppression during rolling deploys. */
  deployHistory: Array<{ sig: string; at: number }>;
  /** Union of route-like paths referenced in the current deploy's JS (code intel). */
  codePaths: string[];
  /** Union of hostnames referenced in the current deploy's JS/HTML (code intel). */
  codeHosts: string[];
  status: StatusState;
  /** Cert Spotter pagination cursor (issuance id) for incremental polling. */
  ctCursor: string | null;
  ctLastPoll: number;
  crtshLastPoll: number;
  dnsLastScan: number;
  sitemapLastScan: number;
  lastCheckAt: number;
  lastChangeAt: number;
  lastError: string | null;
  /** When the (latest) silent baseline pass completed (ms epoch, 0 = never). Items first seen after this are "new". */
  baselineAt: number;
  /** A Cert Spotter backlog is still being paged through (names from it are old → silent). Survives restarts. */
  ctBackfill: boolean;
  /** At least one Cert Spotter poll succeeded (tells "no certificates yet" from "never polled"). Survives restarts. */
  ctPolledOk: boolean;
  /** The silent subdomain baseline completed (subdomain checks may run even while the page baseline is pending). */
  subdomainsBaselined: boolean;
  /** A complete (not partially failed) sitemap read succeeded at least once; later reads can report news. */
  sitemapComplete: boolean;
  /**
   * Recently seen wildcard DNS answers of the root domain ("A:1.2.3.4", …) and whether the wildcard rotates its answers
   * (different random labels get different addresses) — `spread` when its pool is too scattered to match by address
   * prefix. Kept for a day so a restart does not re-learn it from scratch.
   */
  wildcard: { answers: string[]; rotating: boolean; spread?: boolean; at: number } | null;
  /** Asset URLs (with query strings) seen on the homepage recently, for "same files, different ?ver=" per-node variants. */
  seenAssets: Array<{ url: string; at: number }>;
  /** Asset paths (origin + pathname) whose query string changes between back-to-back fetches (per-request cache busters). */
  unstableQueryPaths: string[];
}

export function defaultWatchState(): WatchState {
  return {
    deploy: null,
    deployHistory: [],
    codePaths: [],
    codeHosts: [],
    status: {
      up: true,
      consecutiveFailures: 0,
      consecutiveBlocked: 0,
      lastError: null,
      downSince: null,
      alertedDown: false,
      alertedBlocked: false,
      consecutiveRateLimited: 0,
      alertedRateLimited: false,
    },
    ctCursor: null,
    ctLastPoll: 0,
    crtshLastPoll: 0,
    dnsLastScan: 0,
    sitemapLastScan: 0,
    lastCheckAt: 0,
    lastChangeAt: 0,
    lastError: null,
    baselineAt: 0,
    ctBackfill: false,
    ctPolledOk: false,
    subdomainsBaselined: false,
    sitemapComplete: false,
    wildcard: null,
    seenAssets: [],
    unstableQueryPaths: [],
  };
}

export type PageKind = 'page' | 'file';
export type PageSource = 'start' | 'link' | 'sitemap' | 'extra' | 'code' | 'redirect';

export interface PageRecord {
  watchId: number;
  /** Normalized absolute URL (identity). */
  url: string;
  kind: PageKind;
  /** Content is tracked (fetched each sweep & diffed). false = only "known" (for new-page detection). */
  tracked: boolean;
  title: string | null;
  /** Canonical text snapshot (see pageTextSnapshot) BEFORE ignore patterns/masking, for diffs. Files: null. */
  text: string | null;
  /** Hash used for change detection. Pages: sha1 of compare-text (after ignore patterns & masking). Files: sha1 of bytes. */
  textHash: string | null;
  etag: string | null;
  lastModified: string | null;
  contentLength: number | null;
  contentType: string | null;
  /** Last HTTP status seen (0 = network error). */
  status: number | null;
  /** Consecutive 404/410 (pages & files) — removal alert at 2. */
  failCount: number;
  /** Page/file considered removed (alert already sent). */
  gone: boolean;
  /** Digits masked on every line of this page (set by older versions' auto-detection; the user option is watch.maskNumbers). */
  maskNumbers: boolean;
  /**
   * Masked forms (see maskNumbers()) of lines whose numbers were seen changing on their own (tickers, prices, timestamps):
   * digits are ignored on those lines only, so a real number edit elsewhere on the page is still reported.
   */
  maskedLines: string[];
  /** Timestamps (ms) of recent confirmed number-only changes (for auto-masking). */
  numericChangeTimes: number[];
  /** Consecutive unstable checks (two quick fetches disagree for non-numeric reasons). */
  flapCount: number;
  /** Page judged too dynamic to diff; text alerts disabled for it (still crawled for links). */
  dynamic: boolean;
  /**
   * Compare hash of a number-only change seen once and held back (not yet alerted): it is reported only if the numbers are
   * still the same on the next check, and numbers that keep moving are masked instead. null = nothing pending.
   */
  pendingHash: string | null;
  /** When the held number-only change was first seen (ms epoch), null when nothing is held. */
  pendingSince: number | null;
  /** Recently accepted compare hashes (newest last, max ~10) for text flip-flop (A/B rotation, revert) suppression. */
  hashHistory: Array<{ hash: string; at: number }>;
  /** Times (ms) of recent alerted text changes, for churn detection (pages that change too often are muted). */
  changeTimes: number[];
  source: PageSource;
  depth: number;
  firstSeen: number;
  lastChecked: number;
  lastChanged: number | null;
}

export type SubdomainSource = 'ct' | 'crtsh' | 'dns' | 'link' | 'code';

export interface DnsInfo {
  a: string[];
  aaaa: string[];
  cname: string[];
}

export interface HttpProbe {
  /** 0 = unreachable. */
  status: number;
  title: string | null;
  finalUrl: string | null;
  server: string | null;
}

export interface SubdomainRecord {
  watchId: number;
  /** Lowercase FQDN, no trailing dot, no wildcard prefix. */
  host: string;
  sources: SubdomainSource[];
  firstSeen: number;
  lastSeen: number;
  /** Resolves in DNS (A/AAAA/CNAME). */
  alive: boolean;
  lastProbe: number;
  dns: DnsInfo | null;
  http: HttpProbe | null;
}

export interface JsAnalysis {
  /** Route-like paths ("/docs/points", "/api/v1/claim"). */
  paths: string[];
  /** Hostnames referenced by absolute URLs (lowercase). */
  hosts: string[];
}

export interface EventRecord {
  id: number;
  watchId: number;
  kind: AlertKind;
  summary: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Alerts (produced by monitors, rendered by the notifier)
// ---------------------------------------------------------------------------

export type AlertKind =
  | 'deploy'
  | 'text'
  | 'new_pages'
  | 'removed_pages'
  | 'subdomain'
  | 'subdomain_live'
  | 'file'
  | 'status'
  | 'info';

export interface TextDiff {
  /** Lines only in the new text. */
  added: string[];
  /** Lines only in the old text. */
  removed: string[];
  /** True if old and new are identical once digits are masked. */
  numericOnly: boolean;
  /**
   * Human-readable diff: lines prefixed with "+ ", "- " or "  " (context), hunks separated by "…".
   * Already truncated to `maxLines` lines and each line to ~180 chars.
   */
  unified: string;
  /** sha1 of the (added, removed) sets — identical edits on many pages share this hash. */
  hash: string;
}

export interface DeployAlert {
  kind: 'deploy';
  url: string;
  host: string;
  buildIdOld: string | null;
  buildIdNew: string | null;
  assetsAdded: string[];
  assetsRemoved: string[];
  /** Newly referenced route-like paths in site code (code intel), [] if none/disabled. */
  newCodePaths: string[];
  /** Newly referenced hostnames in site code (code intel), [] if none/disabled. */
  newCodeHosts: string[];
}

export interface TextChange {
  url: string;
  title: string | null;
  diff: TextDiff;
  titleChange: { from: string | null; to: string | null } | null;
}

export interface TextAlert {
  kind: 'text';
  changes: TextChange[];
  /** Changes grouped by identical diff (diff.hash) so a site-wide nav edit is shown once. Largest group first. */
  groups: Array<{ hash: string; urls: string[]; diff: TextDiff }>;
}

export interface NewPagesAlert {
  kind: 'new_pages';
  pages: Array<{ url: string; title: string | null; source: PageSource }>;
}

export interface RemovedPagesAlert {
  kind: 'removed_pages';
  pages: Array<{ url: string; status: number }>;
}

export interface SubdomainInfo {
  host: string;
  sources: SubdomainSource[];
  dns: DnsInfo | null;
  http: HttpProbe | null;
}

export interface SubdomainAlert {
  /** 'subdomain' = never seen before; 'subdomain_live' = known name that just started resolving. */
  kind: 'subdomain' | 'subdomain_live';
  rootDomain: string;
  subdomains: SubdomainInfo[];
}

export interface FileAlert {
  kind: 'file';
  files: Array<{
    url: string;
    change: 'added' | 'modified' | 'removed';
    oldSize: number | null;
    newSize: number | null;
    contentType: string | null;
  }>;
}

export interface StatusAlert {
  kind: 'status';
  url: string;
  up: boolean;
  /** e.g. "HTTP 502", "timeout after 20s", "ECONNREFUSED". */
  detail: string;
  /** For recovery alerts: how long the site was down (ms). */
  downForMs: number | null;
}

export interface InfoAlert {
  kind: 'info';
  message: string;
}

export type Alert =
  | DeployAlert
  | TextAlert
  | NewPagesAlert
  | RemovedPagesAlert
  | SubdomainAlert
  | FileAlert
  | StatusAlert
  | InfoAlert;

/** Delivers alerts somewhere (Discord channel, console, test capture). */
export interface Notifier {
  notify(watch: Watch, alerts: Alert[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}
