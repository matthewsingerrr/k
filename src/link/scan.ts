/**
 * One-off site scan for the Link API (the extension's "Scan" button). Nothing is persisted.
 * STUB — to be implemented. Keep the exported API exactly as declared.
 */
import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import type { HttpClient } from '../net/http.js';
import type { DnsProvider } from '../net/dns.js';
import type { CtProvider } from '../monitor/subdomains.js';
import type { Logger } from '../types.js';
import type { ScanResult } from './types.js';

export interface ScanDeps {
  http: HttpClient;
  store: Store;
  config: Config;
  dns: DnsProvider;
  ct: CtProvider;
  log: Logger;
  now?: () => number;
}

export interface ScanOptions {
  /** Guild asking (to fill `watched`). */
  guildId: string;
  /** 'quick' (default): DNS check of ~40 common labels + hosts seen in code. 'full': also Cert Spotter (rate-limited, cached). 'none'. */
  subdomains?: 'none' | 'quick' | 'full';
  /** Overall time budget (default 25s); partial results are returned when it runs out. */
  budgetMs?: number;
}

/**
 * Scan `rawUrl` (user input like "unpeg.io" or a full URL; invalid → throws an Error with a user-facing message):
 * fetch the homepage (SSRF-protected HttpClient), parse it, fingerprint the build (deploy fingerprint), fetch up to
 * 25 same-site JS bundles (≤ 3MB each, total ≤ 12MB) for code intel (analyzeJs) and tech detection, collect socials,
 * resolve subdomains per `subdomains`, detect tech, and report whether the guild watches this site.
 * Results are cached per (url, subdomains mode) for 60s. Blocked sites return what could be learned (headers, CT/DNS).
 */
export async function scanSite(deps: ScanDeps, rawUrl: string, opts: ScanOptions): Promise<ScanResult> {
  throw new Error('not implemented');
}
