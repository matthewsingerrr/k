/**
 * Dry-run CLI: watch one or more sites WITHOUT Discord and print alerts to the console.
 *
 * Usage:
 *   npm run cli -- <url> [<url> ...] [--interval 30] [--sweep 120] [--once] [--full] [--no-subdomains] [--db ./data/cli.db] [--debug]
 * - Builds Config via loadConfig({requireToken:false}) with CLI overrides; Store at --db (default ":memory:").
 * - ConsoleNotifier: for each payload from formatAlerts(), print content, then each embed's title/url/description/fields in plain text.
 * - Creates each watch (guildId "cli", channelId "cli") unless it already exists in the db, runs baseline (prints BaselineSummary),
 *   then either exits (--once, after one normal checkNow per watch printing TickSummary) or starts the Monitor until Ctrl-C.
 *
 * Extras: `--full` makes the --once check a full sweep; local targets (localhost / private IPs) automatically allow private
 * network access (it is your own machine); only the sites named on the command line are monitored, even with a shared --db.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { loadConfig, type Config } from './config.js';
import { createLogger } from './log.js';
import { Store } from './db/store.js';
import { HttpClient } from './net/http.js';
import { isPrivateAddress } from './net/dns.js';
import { parseWatchInput, type ParsedWatchInput } from './extract/url.js';
import { formatAlerts, type MessagePayload } from './discord/format.js';
import { Monitor, type BaselineSummary, type TickSummary } from './monitor/scheduler.js';
import type { Alert, Notifier, Watch } from './types.js';

export interface CliArgs {
  urls: string[];
  interval: number | null;
  sweep: number | null;
  once: boolean;
  full: boolean;
  subdomains: boolean;
  db: string;
  debug: boolean;
  help: boolean;
}

export const USAGE = `Usage: npm run cli -- <url> [<url> ...] [options]

Watches websites without Discord and prints every alert to the console.

Options:
  --interval <sec>   seconds between checks (default: DEFAULT_INTERVAL_SEC or 30)
  --sweep <sec>      seconds for every tracked page to be re-checked once (default: DEFAULT_SWEEP_SEC or 120)
  --once             baseline, run one normal check, print the result and exit
  --full             with --once: make that check a full sweep of every tracked page and file
  --no-subdomains    skip subdomain discovery (Certificate Transparency, DNS wordlist)
  --db <path>        SQLite file to keep state between runs (default: in-memory)
  --debug            verbose logging
  -h, --help         show this help`;

/** Parse CLI arguments. Throws an Error with a user-facing message on invalid input. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    urls: [],
    interval: null,
    sweep: null,
    once: false,
    full: false,
    subdomains: true,
    db: ':memory:',
    debug: false,
    help: false,
  };
  const value = (name: string, inline: string | undefined, i: number): [string, number] => {
    if (inline !== undefined) return [inline, i];
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
    return [next, i + 1];
  };
  const seconds = (name: string, raw: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 86_400) throw new Error(`${name} must be a whole number of seconds (1-86400), got "${raw}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-') || arg === '-') {
      args.urls.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    switch (name) {
      case '--interval': {
        const [v, j] = value(name, inline, i);
        args.interval = seconds(name, v);
        i = j;
        break;
      }
      case '--sweep': {
        const [v, j] = value(name, inline, i);
        args.sweep = seconds(name, v);
        i = j;
        break;
      }
      case '--db': {
        const [v, j] = value(name, inline, i);
        args.db = v.trim() || ':memory:';
        i = j;
        break;
      }
      case '--once':
        args.once = true;
        break;
      case '--full':
        args.full = true;
        break;
      case '--no-subdomains':
        args.subdomains = false;
        break;
      case '--debug':
        args.debug = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        throw new Error(`unknown option ${name}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Console rendering
// ---------------------------------------------------------------------------

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

/** Plain-text rendering of one Discord message payload. */
export function renderPayload(p: MessagePayload): string {
  const out: string[] = [];
  if (p.content) out.push(p.content);
  for (const e of p.embeds ?? []) {
    const head = [e.title, e.url ? `<${e.url}>` : ''].filter(Boolean).join('  ');
    out.push(`┌ ${head || '(embed)'}`);
    if (e.description) out.push(indent(e.description, '│ '));
    for (const f of e.fields ?? []) out.push(indent(`${f.name}: ${f.value}`, '│ • ').replace(/\n│ • /g, '\n│   '));
    if (e.footer?.text) out.push(`└ ${e.footer.text}`);
    else out.push('└');
  }
  for (const row of p.components ?? []) {
    const labels = row.components.map((c) => `[${(c as { label?: string }).label ?? 'button'}]`);
    if (labels.length) out.push(labels.join(' '));
  }
  return out.join('\n');
}

/** Notifier that prints what the Discord bot would post. */
export class ConsoleNotifier implements Notifier {
  constructor(private readonly write: (text: string) => void = (t) => process.stdout.write(t + '\n')) {}

  async notify(watch: Watch, alerts: Alert[]): Promise<void> {
    if (!Array.isArray(alerts) || alerts.length === 0) return;
    const payloads = formatAlerts(watch, alerts);
    const bar = '━'.repeat(8);
    this.write(`\n${bar} ${watch.name} · ${alerts.length} alert${alerts.length === 1 ? '' : 's'} · ${new Date().toISOString()} ${bar}`);
    for (const p of payloads) this.write(renderPayload(p) + '\n');
  }
}

export function formatBaseline(watch: Watch, s: BaselineSummary): string {
  const parts = [
    `${s.pagesTracked} page${s.pagesTracked === 1 ? '' : 's'} tracked`,
    `${s.pagesKnown} known`,
    `${s.files} file${s.files === 1 ? '' : 's'}`,
  ];
  if (watch.features.subdomains) parts.push(`${s.subdomains} subdomain${s.subdomains === 1 ? '' : 's'}`);
  parts.push(`build ${s.buildId ?? 'unknown'}`, `${s.assets} bundle${s.assets === 1 ? '' : 's'}`);
  const home = s.homeBlocked ? `blocked (HTTP ${s.homeStatus})` : s.homeStatus ? `HTTP ${s.homeStatus}` : 'unreachable';
  const r = s.redirectedTo;
  const redirect = r ? `; ${r.from} redirects to ${r.to} (${r.adopted ? 'watching that' : 'another domain: only the start page is checked'})` : '';
  return `baseline ${watch.name} (${watch.url}): ${parts.join(', ')}; homepage ${home}${redirect}; took ${(s.durationMs / 1000).toFixed(1)}s`;
}

export function formatTick(watch: Watch, t: TickSummary): string {
  const took = `${(t.durationMs / 1000).toFixed(1)}s`;
  const what = t.alerts.length
    ? `${t.alerts.length} alert${t.alerts.length === 1 ? '' : 's'} (${[...new Set(t.alerts.map((a) => a.kind))].join(', ')})`
    : 'no changes';
  return `check ${watch.name}: ${what} in ${took}${t.error ? ` — error: ${t.error}` : ''}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function isLocalTarget(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  return net.isIP(h) !== 0 && isPrivateAddress(h);
}

function upsertWatch(store: Store, target: ParsedWatchInput, args: CliArgs, config: Config): Watch {
  const intervalSec = args.interval ?? config.defaultIntervalSec;
  const sweepSec = args.sweep ?? config.defaultSweepSec;
  const existing = store.findWatchByUrl('cli', target.url);
  if (existing) {
    return store.updateWatch(existing.id, {
      intervalSec,
      sweepSec,
      paused: false,
      features: { subdomains: args.subdomains },
    });
  }
  return store.createWatch({
    guildId: 'cli',
    channelId: 'cli',
    name: target.suggestedName,
    url: target.url,
    host: target.host,
    rootDomain: target.rootDomain,
    createdBy: 'cli',
    intervalSec,
    sweepSec,
    maxPages: config.defaultMaxPages,
    features: { subdomains: args.subdomains },
  });
}

/** Run the CLI. Resolves with the process exit code (watch mode resolves on SIGINT/SIGTERM). */
export async function runCli(argv: string[], write: (text: string) => void = (t) => process.stdout.write(t + '\n')): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    write(`error: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help || args.urls.length === 0) {
    write(USAGE);
    return args.help ? 0 : 2;
  }

  const targets: ParsedWatchInput[] = [];
  for (const raw of args.urls) {
    const parsed = parseWatchInput(raw);
    if (!parsed) {
      write(`error: "${raw}" doesn't look like a website URL`);
      return 2;
    }
    if (!targets.some((t) => t.url === parsed.url)) targets.push(parsed);
  }

  const base = loadConfig({ requireToken: false });
  const config: Config = {
    ...base,
    allowPrivateNetwork: base.allowPrivateNetwork || targets.some((t) => isLocalTarget(t.host)),
    logLevel: args.debug ? 'debug' : base.logLevel,
  };
  if (args.interval !== null && args.interval < config.minIntervalSec) {
    write(`note: --interval ${args.interval} is below MIN_INTERVAL_SEC (${config.minIntervalSec}); using ${config.minIntervalSec}`);
    args.interval = config.minIntervalSec;
  }
  const log = createLogger(config.logLevel);
  const store = new Store(args.db, {
    intervalSec: config.defaultIntervalSec,
    sweepSec: config.defaultSweepSec,
    maxPages: config.defaultMaxPages,
  });
  const http = new HttpClient({
    userAgent: config.userAgent,
    globalConcurrency: config.globalConcurrency,
    perHostConcurrency: config.perHostConcurrency,
    timeoutMs: config.requestTimeoutMs,
    maxBytes: config.maxBodyBytes,
    allowPrivate: config.allowPrivateNetwork,
  });
  const monitor = new Monitor({ store, http, notifier: new ConsoleNotifier(write), config, log: log.child({ mod: 'monitor' }) });

  // The monitor's timers are unref'd (they never keep a bot process alive by themselves), and so is the confirm delay:
  // a --once check that is only waiting out a confirm delay, or watch mode waiting for Ctrl-C, would let Node exit
  // mid-run. Hold the event loop open until the CLI is done.
  const keepAlive = setInterval(() => {}, 1 << 30);
  const shutdown = async () => {
    clearInterval(keepAlive);
    await monitor.stop();
    store.close();
  };

  try {
    const watches = targets.map((t) => upsertWatch(store, t, args, config));
    for (const watch of watches) {
      if (watch.baselineDone) {
        write(`baseline ${watch.name}: already recorded in ${args.db}`);
        continue;
      }
      write(`baseline ${watch.name} (${watch.url}): scanning…`);
      const summary = await monitor.runBaseline(watch.id);
      write(formatBaseline(store.getWatch(watch.id) ?? watch, summary));
    }

    if (args.once) {
      let failed = false;
      for (const watch of watches) {
        const tick = await monitor.checkNow(watch.id, { full: args.full });
        write(formatTick(watch, tick));
        if (tick.error) failed = true;
      }
      await shutdown();
      return failed ? 1 : 0;
    }

    for (const watch of watches) {
      const fresh = store.getWatch(watch.id);
      if (fresh) monitor.onWatchAdded(fresh);
    }
    write(`watching ${watches.length} site${watches.length === 1 ? '' : 's'} — Ctrl-C to stop`);
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    });
    write('stopping…');
    await shutdown();
    return 0;
  } catch (err) {
    write(`error: ${err instanceof Error ? err.message : String(err)}`);
    try {
      await shutdown();
    } catch {
      // already failing
    }
    return 1;
  }
}

function invokedDirectly(): boolean {
  try {
    const entry = process.argv[1];
    return Boolean(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error('fatal:', err);
      process.exit(1);
    },
  );
}
