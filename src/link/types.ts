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
  error: { code: string; message: string };
}
