/**
 * CLI: argument parsing, console rendering of Discord payloads, and a full offline `--once` run against a local site.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConsoleNotifier, formatBaseline, formatTick, parseArgs, renderPayload, runCli } from '../src/cli.js';
import { DEFAULT_FEATURES, type Watch } from '../src/types.js';

const watch: Watch = {
  id: 1,
  guildId: 'cli',
  channelId: 'cli',
  name: 'Unpeg',
  url: 'https://unpeg.io/',
  host: 'unpeg.io',
  rootDomain: 'unpeg.io',
  intervalSec: 30,
  sweepSec: 120,
  maxPages: 150,
  pingRoleId: null,
  features: { ...DEFAULT_FEATURES },
  ignorePatterns: [],
  excludePatterns: [],
  extraUrls: [],
  scopePath: null,
  maskNumbers: false,
  paused: false,
  baselineDone: true,
  createdBy: 'cli',
  createdAt: 0,
};

describe('parseArgs', () => {
  it('parses urls and every flag (space and = forms)', () => {
    expect(parseArgs(['unpeg.io', '--interval', '15', '--sweep=300', '--once', '--full', '--no-subdomains', '--db', './x.db', '--debug', 'b.io'])).toEqual({
      urls: ['unpeg.io', 'b.io'],
      interval: 15,
      sweep: 300,
      once: true,
      full: true,
      subdomains: false,
      db: './x.db',
      debug: true,
      help: false,
    });
    expect(parseArgs([])).toMatchObject({ urls: [], interval: null, sweep: null, once: false, subdomains: true, db: ':memory:' });
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('rejects bad values and unknown options', () => {
    expect(() => parseArgs(['--interval'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--interval', '--once'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--interval', 'abc'])).toThrow(/whole number/);
    expect(() => parseArgs(['--sweep=0'])).toThrow(/whole number/);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option --nope/);
  });
});

describe('console rendering', () => {
  it('renders content, embeds, fields and buttons as plain text', () => {
    const text = renderPayload({
      content: '🚀 **Unpeg** redeployed',
      embeds: [
        {
          title: 'Redeploy',
          url: 'https://unpeg.io/',
          description: 'line 1\nline 2',
          fields: [{ name: 'Build', value: 'a → b\nmore' }],
          footer: { text: 'Unpeg · unpeg.io' },
        },
      ],
      components: [{ type: 1, components: [{ type: 2, style: 2, label: 'Watch api.unpeg.io', custom_id: 'watchsub:1:api.unpeg.io' }] }],
      allowedMentions: { parse: [] },
    });
    expect(text).toBe(
      [
        '🚀 **Unpeg** redeployed',
        '┌ Redeploy  <https://unpeg.io/>',
        '│ line 1',
        '│ line 2',
        '│ • Build: a → b',
        '│   more',
        '└ Unpeg · unpeg.io',
        '[Watch api.unpeg.io]',
      ].join('\n'),
    );
  });

  it('ConsoleNotifier prints every formatted payload of a batch', async () => {
    const out: string[] = [];
    await new ConsoleNotifier((t) => out.push(t)).notify(watch, [
      { kind: 'status', url: watch.url, up: false, detail: 'HTTP 502', downForMs: null },
      { kind: 'new_pages', pages: [{ url: 'https://unpeg.io/docs/points', title: 'Points', source: 'link' }] },
    ]);
    const all = out.join('\n');
    expect(out[0]).toMatch(/Unpeg · 2 alerts/);
    expect(all).toContain('HTTP 502');
    expect(all).toContain('/docs/points');
    await new ConsoleNotifier((t) => out.push(t)).notify(watch, []);
  });

  it('formats baseline and tick summaries', () => {
    expect(
      formatBaseline(watch, {
        watchId: 1,
        pagesTracked: 12,
        pagesKnown: 14,
        files: 1,
        subdomains: 3,
        buildId: 'KU791SoC2tXw-mGI_0Sms',
        assets: 9,
        homeStatus: 200,
        homeBlocked: false,
        durationMs: 1800,
      }),
    ).toBe(
      'baseline Unpeg (https://unpeg.io/): 12 pages tracked, 14 known, 1 file, 3 subdomains, build KU791SoC2tXw-mGI_0Sms, 9 bundles; homepage HTTP 200; took 1.8s',
    );
    expect(
      formatBaseline(watch, {
        watchId: 1, pagesTracked: 1, pagesKnown: 1, files: 0, subdomains: 0, buildId: null, assets: 0, homeStatus: 200,
        homeBlocked: false, durationMs: 100, redirectedTo: { from: 'unpeg.io', to: 'www.unpeg.io', adopted: true },
      }),
    ).toContain('; unpeg.io redirects to www.unpeg.io (watching that)');
    expect(formatTick(watch, { watchId: 1, alerts: [], durationMs: 250, error: null })).toBe('check Unpeg: no changes in 0.3s');
    expect(
      formatTick(watch, { watchId: 1, alerts: [{ kind: 'info', message: 'x' }, { kind: 'info', message: 'y' }], durationMs: 1000, error: 'boom' }),
    ).toBe('check Unpeg: 2 alerts (info) in 1.0s — error: boom');
  });
});

describe('runCli', () => {
  let server: http.Server;
  let origin = '';
  const savedLevel = process.env.LOG_LEVEL;

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'error';
    server = http.createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const html = (title: string, body: string) =>
        `<!DOCTYPE html><html><head><title>${title}</title><script src="/_next/static/chunks/main-abc123.js"></script></head><body>${body}</body></html>`;
      if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(html('Local', '<a href="/docs">Docs</a><a href="/paper.pdf">Paper</a>'));
      } else if (path === '/docs') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(html('Docs', '<p>Docs here</p>'));
      } else if (path === '/paper.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4 local');
      } else if (path.endsWith('.js')) {
        res.writeHead(200, { 'content-type': 'application/javascript' }).end('let a="/docs";');
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('nope');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (savedLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLevel;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('--once baselines a local site (private network allowed automatically) and runs one quiet check', async () => {
    const out: string[] = [];
    const code = await runCli([`${origin}/`, '--once', '--no-subdomains'], (t) => out.push(t));
    expect(out.join('\n')).not.toMatch(/error/);
    expect(code).toBe(0);
    expect(out.some((l) => /^baseline 127\.0\.0\.1 \(.*\): 2 pages tracked, 2 known, 1 file, build unknown, 1 bundle; homepage HTTP 200/.test(l))).toBe(
      true,
    );
    expect(out.at(-1)).toMatch(/^check 127\.0\.0\.1: no changes in \d+\.\ds$/);
  });

  it('watch mode keeps running until Ctrl-C (the monitor timers alone do not hold the process open)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-watch-'));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', `${origin}/`, '--no-subdomains', '--interval', '5', '--db', join(dir, 'w.db')], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, LOG_LEVEL: 'error' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    let exitCode: number | null | undefined;
    const exited = new Promise<void>((r) => child.on('exit', (code) => ((exitCode = code), r())));
    try {
      for (let i = 0; i < 200 && !stdout.includes('watching 1 site'); i++) await new Promise((r) => setTimeout(r, 100));
      expect(stdout).toContain('watching 1 site');
      await new Promise((r) => setTimeout(r, 1500));
      expect(exitCode).toBeUndefined(); // still running
      child.kill('SIGINT');
      await exited;
      expect(exitCode).toBe(0);
      expect(stdout).toContain('stopping…');
    } finally {
      if (exitCode === undefined) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it('prints usage for --help / no urls and rejects invalid urls', async () => {
    const out: string[] = [];
    expect(await runCli(['--help'], (t) => out.push(t))).toBe(0);
    expect(out[0]).toMatch(/^Usage:/);
    expect(await runCli([], (t) => out.push(t))).toBe(2);
    expect(await runCli(['not a url'], (t) => out.push(t))).toBe(2);
    expect(await runCli(['ftp://x.io'], (t) => out.push(t))).toBe(2);
    expect(await runCli(['x.io', '--bogus'], (t) => out.push(t))).toBe(2);
    expect(out.join('\n')).toMatch(/unknown option --bogus/);
  });
});
