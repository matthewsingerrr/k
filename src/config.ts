import path from 'node:path';

export interface Config {
  discordToken: string;
  /** Optional: restrict slash-command registration to one guild. */
  discordGuildId: string | null;
  /** Directory holding the SQLite database. On Railway this should be a mounted volume. */
  dataDir: string;
  /** True when DATA_DIR is a Railway volume (or not on Railway at all). */
  dataDirPersistent: boolean;
  /** HTTP port for the /health endpoint. */
  port: number;
  userAgent: string;
  /** Max concurrent outbound HTTP requests overall. */
  globalConcurrency: number;
  /** Max concurrent outbound HTTP requests per hostname. */
  perHostConcurrency: number;
  /** Default fast-tick interval for new watches (seconds). */
  defaultIntervalSec: number;
  /** Minimum allowed interval (seconds). */
  minIntervalSec: number;
  /** Default full page-sweep period for new watches (seconds). */
  defaultSweepSec: number;
  defaultMaxPages: number;
  /** Hard cap on "known" (untracked) URLs per watch. */
  maxKnownUrls: number;
  /** Seconds between subdomain checks (Cert Spotter incremental poll + probes of pending names). */
  subdomainIntervalSec: number;
  /** Seconds between crt.sh full polls (slow, best effort). */
  crtshIntervalSec: number;
  /** Seconds between DNS wordlist sweeps. */
  dnsScanIntervalSec: number;
  /** Seconds between sitemap re-discovery. */
  sitemapIntervalSec: number;
  certspotterApiKey: string | null;
  /** Cert Spotter budget shared by all watches (full-domain queries per hour; the free tier allows 10, with or without a key). */
  certspotterQueriesPerHour: number;
  /** Max watches per Discord server (0 = unlimited). */
  maxWatchesPerGuild: number;
  /** Allow fetching private/loopback/link-local addresses (tests & self-hosting only). */
  allowPrivateNetwork: boolean;
  /** Per-request timeout (ms). */
  requestTimeoutMs: number;
  /** Max body bytes read for HTML/JS (larger bodies are truncated). */
  maxBodyBytes: number;
  /** Max bytes hashed for tracked files (pdf etc.). */
  maxFileBytes: number;
  /** Delay before the confirmation re-fetch of a changed page/fingerprint (ms). */
  confirmDelayMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function int(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) throw new Error(`Env ${name} must be an integer >= ${min} (got "${raw}")`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/** True if `child` is `parent` or inside it (path boundary aware: "/data2" is not inside "/data"). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * Load configuration from environment variables.
 * `requireToken=false` is used by the CLI dry-run and tests.
 */
export function loadConfig(opts: { requireToken?: boolean } = {}): Config {
  const requireToken = opts.requireToken ?? true;
  const token = process.env.DISCORD_TOKEN?.trim() ?? '';
  if (requireToken && !token) {
    throw new Error('DISCORD_TOKEN is not set. Create a bot at https://discord.com/developers/applications and set DISCORD_TOKEN.');
  }
  const railwayVolume = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() || null;
  const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
  const dataDir = path.resolve(process.env.DATA_DIR?.trim() || railwayVolume || './data');
  const dataDirPersistent = !onRailway || (railwayVolume !== null && isInside(path.resolve(railwayVolume), dataDir));
  const level = (process.env.LOG_LEVEL?.trim().toLowerCase() || 'info') as Config['logLevel'];

  return {
    discordToken: token,
    discordGuildId: process.env.DISCORD_GUILD_ID?.trim() || null,
    dataDir,
    dataDirPersistent,
    port: int('PORT', 3000, 1),
    userAgent: process.env.USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    globalConcurrency: int('GLOBAL_CONCURRENCY', 16, 1),
    perHostConcurrency: int('PER_HOST_CONCURRENCY', 4, 1),
    defaultIntervalSec: int('DEFAULT_INTERVAL_SEC', 2, 1),
    minIntervalSec: int('MIN_INTERVAL_SEC', 1, 1),
    defaultSweepSec: int('DEFAULT_SWEEP_SEC', 120, 10),
    defaultMaxPages: int('DEFAULT_MAX_PAGES', 150, 1),
    maxKnownUrls: int('MAX_KNOWN_URLS', 5000, 10),
    subdomainIntervalSec: int('SUBDOMAIN_INTERVAL_SEC', 300, 30),
    crtshIntervalSec: int('CRTSH_INTERVAL_SEC', 1800, 60),
    dnsScanIntervalSec: int('DNS_SCAN_INTERVAL_SEC', 900, 60),
    sitemapIntervalSec: int('SITEMAP_INTERVAL_SEC', 600, 30),
    certspotterApiKey: process.env.CERTSPOTTER_API_KEY?.trim() || null,
    certspotterQueriesPerHour: int('CERTSPOTTER_QUERIES_PER_HOUR', 10, 1),
    maxWatchesPerGuild: int('MAX_WATCHES_PER_GUILD', 50, 0),
    allowPrivateNetwork: bool('ALLOW_PRIVATE_NETWORK', false),
    requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 20_000, 1000),
    maxBodyBytes: int('MAX_BODY_BYTES', 5 * 1024 * 1024, 1024),
    maxFileBytes: int('MAX_FILE_BYTES', 30 * 1024 * 1024, 1024),
    confirmDelayMs: int('CONFIRM_DELAY_MS', 2500, 0),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
  };
}

/** Config for tests / the CLI: no token, private network allowed, fast confirm. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    discordToken: '',
    discordGuildId: null,
    dataDir: ':memory:',
    dataDirPersistent: true,
    port: 0,
    userAgent: DEFAULT_USER_AGENT,
    globalConcurrency: 16,
    perHostConcurrency: 8,
    defaultIntervalSec: 30,
    minIntervalSec: 1,
    defaultSweepSec: 120,
    defaultMaxPages: 150,
    maxKnownUrls: 5000,
    subdomainIntervalSec: 300,
    crtshIntervalSec: 1800,
    dnsScanIntervalSec: 900,
    sitemapIntervalSec: 600,
    certspotterApiKey: null,
    certspotterQueriesPerHour: 10,
    maxWatchesPerGuild: 50,
    allowPrivateNetwork: true,
    requestTimeoutMs: 5000,
    maxBodyBytes: 5 * 1024 * 1024,
    maxFileBytes: 30 * 1024 * 1024,
    confirmDelayMs: 0,
    logLevel: 'warn',
    ...overrides,
  };
}
