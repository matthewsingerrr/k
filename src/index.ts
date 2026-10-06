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
import { startHealthServer, type HttpRouteHandler } from './health.js';
import { createDnsProvider } from './net/dns.js';
import { createCtProvider } from './monitor/subdomains.js';
import { createLinkApi } from './link/api.js';
import { LINK_API_PREFIX } from './link/types.js';

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

  // One DNS resolver and one Certificate Transparency budget for the monitor and the Link API's scans: Cert Spotter's
  // quota is per IP, so two separate buckets would only make both run into 429s.
  const dns = createDnsProvider();
  const ct = createCtProvider(http, {
    certspotterApiKey: config.certspotterApiKey,
    queriesPerHour: config.certspotterQueriesPerHour,
  });
  monitor = new Monitor({ store, http, notifier: bot.notifier, config, log: log.child({ mod: 'monitor' }), providers: { ct, dns } });

  // Link API (/api/v1): lets the browser extension / other bots scan sites and add them to this server's watch list.
  let linkApi: HttpRouteHandler | null = null;
  if (config.linkApi) {
    const linkLog = log.child({ mod: 'link' });
    linkApi = createLinkApi({
      store,
      config,
      log: linkLog,
      getMonitor: () => monitor,
      scan: { http, dns, ct },
      // A server that removed the bot can't keep using its tokens. Before the gateway is ready the guild cache is empty,
      // so every guild counts as present until then (unavailable guilds stay in the cache during Discord outages).
      isGuildActive: (guildId) => !bot.isReady() || bot.client.guilds.cache.has(guildId),
      isRestoring: () => panels?.restoring() ?? true,
      announce: async (channelId, content) => {
        try {
          if (!bot.isReady()) {
            // Sites added right after a deploy: give the gateway a moment instead of dropping the notice.
            await Promise.race([bot.ready, new Promise((r) => setTimeout(r, 30_000).unref())]);
            if (!bot.isReady()) {
              linkLog.info('Discord not ready — link notice skipped', { channelId });
              return;
            }
          }
          const channel = await bot.client.channels.fetch(channelId);
          if (!channel || !channel.isSendable()) {
            linkLog.warn('link notice: the channel is missing or the bot cannot post there', { channelId });
            return;
          }
          await channel.send({ content, allowedMentions: { parse: [] } });
        } catch (err) {
          linkLog.warn('link notice failed', { channelId, err: err instanceof Error ? err.message : String(err) });
        }
      },
    });
    log.info(`Link API on ${config.publicUrl ?? `port ${config.port}`}${LINK_API_PREFIX}`);
    const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
    if (!config.publicUrl && onRailway) {
      log.warn(
        'This service has no public domain, so the browser extension cannot reach the Link API. ' +
          'Railway → this service → Settings → Networking → Generate Domain (or set PUBLIC_URL), then redeploy.',
      );
    }
  }

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
    { linkApi },
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
