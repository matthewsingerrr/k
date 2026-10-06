/**
 * Contract of the Link API: how outside clients (the Arkham Dev Tags browser extension, other bots) talk to this bot.
 * Every response body is JSON. Breaking changes need a new /api/v2 prefix — the extension ships to users as a zip and
 * can't be updated in lockstep.
 */

export const LINK_API_PREFIX = '/api/v1';

export type TechCategory =
  | 'framework'
  | 'hosting'
  | 'cdn'
  | 'cms'
  | 'docs'
  | 'ui'
  | 'analytics'
  | 'monitoring'
  | 'auth'
  | 'payments'
  | 'support'
  | 'web3'
  | 'fonts'
  | 'security'
  | 'other';

export interface TechHit {
  /** Display name, e.g. "Next.js", "Vercel", "Privy", "Solana web3.js". */
  name: string;
  category: TechCategory;
  /** Version when detectable (e.g. from a generator tag or bundle banner), else null. */
  version: string | null;
  /** Short human hint of why it was detected ("x-vercel-id header", "script cdn.privy.io"). */
  evidence: string;
}

export interface ScanSubdomain {
  host: string;
  /** 'dns' | 'ct' | 'code' | 'link' */
  sources: string[];
  alive: boolean;
}

export interface ScanResult {
  /** The URL that was asked for (normalized). */
  url: string;
  finalUrl: string;
  host: string;
  rootDomain: string;
  /** HTTP status of the homepage; 0 = unreachable. */
  status: number;
  /** The site showed the bot a bot-protection challenge (results are then partial). */
  blocked: boolean;
  error: string | null;
  title: string | null;
  description: string | null;
  ogImage: string | null;
  tech: TechHit[];
  build: { id: string | null; assets: number; generator: string | null };
  server: { server: string | null; poweredBy: string | null; ips: string[] };
  /** Route-like API paths referenced in the site's own JS ("/api/launches/count"). */
  apiEndpoints: string[];
  /** Hostnames referenced in the site's code (APIs, RPCs, third-party services). */
  codeHosts: string[];
  subdomains: ScanSubdomain[];
  /** Social / community links found on the homepage, by kind ("x", "telegram", "discord", "github", "docs", "medium", ...). */
  socials: Array<{ kind: string; url: string }>;
  links: { internal: number; external: number };
  /** Whether this guild already tracks the site (null if not). */
  watched: { id: number; name: string; url: string } | null;
  scannedAt: string;
  elapsedMs: number;
}

/** Watch as exposed over the API (no internal state). */
export interface ApiWatch {
  id: number;
  name: string;
  url: string;
  host: string;
  channelId: string;
  intervalSec: number;
  paused: boolean;
  /** "up" | "down" | "blocked" | "paused" | "scanning" */
  status: string;
  features: Record<string, boolean>;
  createdAt: number;
  lastCheckAt: number | null;
  lastChangeAt: number | null;
  pagesTracked: number;
  subdomains: number;
}

export interface ApiEvent {
  id: number;
  watchId: number;
  watchName: string;
  watchUrl: string;
  kind: string;
  summary: string;
  createdAt: number;
}

export interface ApiError {
  /** `field`: JSON path into the request body of the value that failed validation (only on some validation errors). */
  error: { code: string; message: string; field?: string };
}

// ---------------------------------------------------------------------------
// Management (the Discord site card, its buttons and the server list)
// ---------------------------------------------------------------------------

/** The on/off switches of a watch (the dashboard's 🧩 Features view). */
export type ToggleKey = 'deploy' | 'text' | 'pages' | 'subdomains' | 'files' | 'status' | 'codeIntel' | 'maskNumbers';

/** Validation limits, so a client can check input before sending it. */
export interface ApiLimits {
  minIntervalSec: number;
  maxIntervalSec: number;
  sweepMinSec: number;
  sweepMaxSec: number;
  maxPagesLimit: number;
  /** Per list (ignore patterns, skipped URL patterns). */
  maxPatterns: number;
  maxPatternChars: number;
  maxExtraUrls: number;
  maxScopeChars: number;
  maxNameChars: number;
  /** Sites per server (0 = unlimited). */
  maxWatches: number;
}

/** The Discord site card as data. Every string from a website or from Discord is plain text: render it as text. */
export interface ApiCard {
  id: number;
  name: string;
  url: string;
  host: string;
  rootDomain: string;
  /** Same value as ApiWatch.status: up | down | blocked | paused | scanning. */
  status: string;
  /** "Up" | "Down" | "Paused" | "First scan pending" | "Blocked by the site’s bot protection". */
  statusLabel: string;
  /** ms; only while down and not paused. */
  downSince: number | null;
  /** Only while down and not paused. */
  downError: string | null;
  lastCheckAt: number | null;
  lastChangeAt: number | null;
  schedule: { intervalSec: number; sweepSec: number };
  alerts: {
    channelId: string;
    /** null when Discord's cache doesn't know it. */
    channelName: string | null;
    /** null = unknown (Discord not ready). */
    canPost: boolean | null;
    /** "View Channel" | "Send Messages" | "Embed Links" | "channel not found". */
    missing: string[];
    ping: 'none' | 'role' | 'everyone';
    /** The guild id when ping = everyone. */
    pingRoleId: string | null;
    pingRoleName: string | null;
  };
  /** null = no fingerprint yet ("unknown"). */
  build: { id: string | null; bundles: number; generator: string | null } | null;
  pages: { tracked: number; maxPages: number; known: number; files: number; gone: number; dynamic: number };
  subdomains: { enabled: boolean; known: number; live: number };
  rules: { ignorePatterns: number; excludePatterns: number; extraUrls: number; scopePath: string | null };
  /** In the dashboard's order. */
  checks: Array<{ key: ToggleKey; label: string; emoji: string; hint: string; on: boolean }>;
  /** null when the monitor hasn't started. */
  runtime: { running: boolean; baselineRunning: boolean; lastTickAt: number | null; lastTickMs: number | null; nextTickAt: number | null } | null;
  lastError: string | null;
  /** Plain text: delivery problem, shared Certificate Transparency quota. */
  warnings: string[];
  createdAt: number;
}

export interface ApiRules {
  ignorePatterns: string[];
  excludePatterns: string[];
  /** Normalized absolute URLs. */
  extraUrls: string[];
  /** null = whole site. */
  scopePath: string | null;
  maxPages: number;
}

/** Result of every management write. */
export interface ApiManageResult {
  /** e.g. ["intervalSec", "checks.text"]; [] = nothing changed (nothing written). */
  changed: string[];
  /** Plain text, e.g. "Saved — interval 2s → 5s · Text changes off" | "Nothing changed." */
  message: string;
  /** Plain text. */
  warnings: string[];
  watch: ApiWatch;
  card: ApiCard;
}

export interface ApiServerSummary {
  total: number;
  /** Sites per server (0 = unlimited). */
  limit: number;
  counts: { up: number; down: number; blocked: number; paused: number; scanning: number };
  /** Most watches first. */
  channels: Array<{ id: string; name: string | null; watches: number }>;
  /** "Watching 13 sites · alerts in #scans · 9 up · 1 blocked · 1 paused · 2 scanning" */
  text: string;
}

export interface ApiPage {
  url: string;
  path: string;
  title: string | null;
  kind: 'page' | 'file';
  tracked: boolean;
  gone: boolean;
  dynamic: boolean;
  /** Last HTTP status (0 = network error). */
  status: number | null;
  /** start | link | sitemap | extra | code | redirect */
  source: string;
  depth: number;
  firstSeen: number;
  lastChecked: number | null;
  lastChanged: number | null;
  contentType: string | null;
  contentLength: number | null;
}

export interface ApiSubdomain {
  host: string;
  /** ct | crtsh | dns | link | code */
  sources: string[];
  alive: boolean;
  firstSeen: number;
  lastSeen: number;
  dns: { a: string[]; aaaa: string[]; cname: string[] } | null;
  http: { status: number; title: string | null; finalUrl: string | null; server: string | null } | null;
  /** This server already watches https://<host>/. */
  watchedAs: { id: number; name: string } | null;
}

export interface ApiGuildInfo {
  guild: { id: string; name: string };
  tokenChannelId: string;
  channels: Array<{ id: string; name: string; type: 'text' | 'announcement'; category: string | null; canPost: boolean; missing: string[] }>;
  roles: Array<{ id: string; name: string; everyone: boolean; managed: boolean; color: number }>;
}
