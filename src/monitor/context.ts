import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import type { HttpClient, FetchResult } from '../net/http.js';
import type { DnsProvider } from '../net/dns.js';
import type { ParsedPage } from '../extract/html.js';
import type { Logger, Watch, WatchState } from '../types.js';
import type { CtProvider } from './subdomains.js';

/**
 * Everything a checker needs for one watch. Built by the scheduler per tick.
 * `state` is the scheduler's single in-memory WatchState object for this watch — checkers mutate it in place;
 * the scheduler persists it (store.saveState) after each tick / subdomain run.
 */
export interface CheckContext {
  watch: Watch;
  state: WatchState;
  store: Store;
  http: HttpClient;
  config: Config;
  log: Logger;
  providers: { ct: CtProvider; dns: DnsProvider };
  /** Clock (ms). Tests inject a fake. */
  now: () => number;
  /** Sleep used for confirm re-fetch delays (tests inject a no-op). */
  sleep: (ms: number) => Promise<void>;
  /**
   * Baseline mode: record everything, emit NO alerts (return empty alert lists) and never treat anything as "new"/"changed".
   * True for the first scan of a watch.
   */
  baseline: boolean;
  /**
   * True once the scheduler gave up on this run (its timeout guard fired, or the process is shutting down): checkers stop
   * starting new fetches so the run settles quickly. Work not done stays due for the next run.
   */
  cancelled?: () => boolean;
  /**
   * Per-checker silence for one run after a settings change (a feature switched on, scope/exclusions changed): what that
   * checker finds is recorded like during a baseline, while every other checker alerts normally.
   * discovery = new pages (and their hosts/files), files = linked files, subdomains = the subdomain run.
   */
  silent?: { discovery?: boolean; files?: boolean; subdomains?: boolean };
}

/** Homepage fetch shared by the checkers during one tick. `parsed` is null if the response wasn't a 2xx HTML page. */
export interface HomeSnapshot {
  fetch: FetchResult;
  parsed: ParsedPage | null;
}
