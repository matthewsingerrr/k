import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { Store } from './db/store.js';
import { HttpClient } from './net/http.js';
import { Monitor } from './monitor/scheduler.js';
import { startBot } from './discord/bot.js';
import { PanelManager } from './discord/backup.js';
import { Events } from 'discord.js';
import { startHealthServer } from './health.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  if (!config.dataDirPersistent) {
    log.warn(
      `DATA_DIR (${config.dataDir}) is not on a Railway volume — watches and history will be LOST on every redeploy. ` +
        'Attach a volume in Railway (e.g. mount path /data); the bot picks it up automatically.',
    );
  }

  const store = new Store(path.join(config.dataDir, 'watcher.db'), {
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

  let monitor: Monitor | null = null;
  let panels: PanelManager | null = null;
  const bot = await startBot({
    config,
    store,
    log: log.child({ mod: 'discord' }),
    getMonitor: () => {
      if (!monitor) throw new Error('monitor not started yet');
      return monitor;
    },
    getPanelHost: () => panels,
  });

  // Dashboard + watch-list backup in Discord: survives redeploys even without a Railway volume.
  panels = new PanelManager({
    client: bot.client,
    store,
    config,
    log: log.child({ mod: 'panel' }),
    getMonitor: () => monitor,
    onRestored: (watch) => monitor?.onWatchAdded(watch),
  });
  void bot.ready.then(() => panels?.start()).catch((err) => log.error('dashboard start failed', { err }));
  bot.client.on(Events.GuildCreate, (guild) => void panels?.onGuildAvailable(guild).catch(() => {}));

  monitor = new Monitor({ store, http, notifier: bot.notifier, config, log: log.child({ mod: 'monitor' }) });

  const health = startHealthServer(
    config.port,
    {
      discordReady: () => bot.isReady(),
      everReady: () => bot.wasEverReady(),
      watches: () => store.listWatches().length,
      lastActivityAt: () => monitor?.lastActivityAt() ?? null,
      httpStats: () => http.stats(),
    },
    log,
  );

  // Start monitoring right away; alerts are queued until the Discord client is ready.
  monitor.start();
  const watches = store.listWatches();
  log.info(`monitoring ${watches.length} site(s)`);
  const ctWatches = watches.filter((w) => w.features.subdomains && !w.paused).length;
  if (!config.certspotterApiKey && ctWatches > 2) {
    log.warn(
      `${ctWatches} watches scan subdomains without CERTSPOTTER_API_KEY: they share this host's Certificate Transparency ` +
        `quota (${config.certspotterQueriesPerHour} queries/hour) with every other client on the same IP, so new names can take a while.`,
    );
  }

  // Housekeeping: prune old events & JS cache shortly after start (a service redeployed more often than daily would
  // otherwise never prune), then every 6 hours.
  const runHousekeeping = () => {
    try {
      store.pruneEvents(Date.now() - 90 * 24 * 3600 * 1000);
      store.pruneJsCache(5000);
    } catch (err) {
      log.warn('housekeeping failed', { err });
    }
  };
  const firstHousekeeping = setTimeout(runHousekeeping, 60_000);
  firstHousekeeping.unref();
  const housekeeping = setInterval(runHousekeeping, 6 * 3600 * 1000);
  housekeeping.unref();

  // A stalled event loop stalls every watch, Discord and /health at once: make it visible in the logs.
  const loopDelay = monitorEventLoopDelay({ resolution: 50 });
  loopDelay.enable();
  const loopWatch = setInterval(() => {
    const maxMs = loopDelay.max / 1e6;
    if (maxMs > 2000) log.warn('the event loop was blocked', { maxMs: Math.round(maxMs) });
    loopDelay.reset();
  }, 60_000);
  loopWatch.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    const force = setTimeout(() => process.exit(0), 15_000);
    force.unref();
    clearTimeout(firstHousekeeping);
    clearInterval(housekeeping);
    clearInterval(loopWatch);
    loopDelay.disable();
    try {
      panels?.stop();
      await monitor?.stop();
      // Give alerts still queued for Discord a last chance to go out.
      await Promise.race([bot.notifier.flush(), new Promise((r) => setTimeout(r, 3000).unref())]);
      await bot.destroy();
      health.close();
      store.close();
    } catch (err) {
      log.error('error during shutdown', { err });
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { reason: reason instanceof Error ? reason : String(reason) }));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception — exiting so Railway restarts the service', { err });
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('fatal startup error:', err);
  process.exit(1);
});
