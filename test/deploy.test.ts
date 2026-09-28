import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FLIP_FLOP_WINDOW_MS,
  checkDeploy,
  fingerprintFromPage,
  fingerprintNoQuery,
  isFlipFlop,
  type DeployCheckResult,
} from '../src/monitor/deploy.js';
import { parseHtml, type ParsedPage } from '../src/extract/html.js';
import { sha1 } from '../src/diff/text.js';
import type { WatchFeatures } from '../src/types.js';
import {
  fakeFetch,
  fileRecord,
  homeFromHtml,
  fetchHome,
  makeHarness,
  startFakeSite,
  type FakeSite,
  type Harness,
} from './helpers/core-monitor-harness.js';

const FIXTURE = fs.readFileSync(new URL('./fixtures/nextjs-app-home.html', import.meta.url), 'utf8');
const OLD_BUILD = 'KU791SoC2tXw-mGI_0Sms';
const OLD_CHUNK = '310vm2bl3xxpt.js';
const NEW_CHUNK = '9newchunk00aa.js';
const NEW_BUILD = 'NewBuild_12345678';
const DEFAULT_JS = 'self.__r=["/docs/how-it-works","/app"];fetch("https://rpc.unpeg.io/v1");';

function deployHtml(chunk = NEW_CHUNK, build = NEW_BUILD): string {
  return FIXTURE.split(OLD_CHUNK).join(chunk).split(OLD_BUILD).join(build);
}

// ---------------------------------------------------------------------------
// Pure fingerprinting
// ---------------------------------------------------------------------------

describe('fingerprintFromPage', () => {
  it('fingerprints the real Next.js app-router homepage', () => {
    const parsed = parseHtml(FIXTURE, 'http://127.0.0.1:9999/');
    const fp = fingerprintFromPage(parsed, '127.0.0.1', 5);
    expect(fp.buildId).toBe(OLD_BUILD);
    expect(fp.assets).toHaveLength(9); // 8 scripts + 1 stylesheet (the preload duplicates a script)
    expect(fp.assets).toEqual([...fp.assets].sort());
    expect(fp.assets).toContain(`http://127.0.0.1:9999/_next/static/chunks/${OLD_CHUNK}`);
    expect(fp.assets).toContain('http://127.0.0.1:9999/_next/static/chunks/0--9-y9nvg2ye.css');
    expect(fp.sig).toBe(sha1(`${OLD_BUILD}\n${fp.assets.join('\n')}`));
    expect(fp.seenAt).toBe(5);
    expect(fp.generator).toBeNull();
    // Same page → same signature; a new build → a new signature.
    expect(fingerprintFromPage(parseHtml(FIXTURE, 'http://127.0.0.1:9999/'), '127.0.0.1', 6).sig).toBe(fp.sig);
    expect(fingerprintFromPage(parseHtml(deployHtml(), 'http://127.0.0.1:9999/'), '127.0.0.1', 6).sig).not.toBe(fp.sig);
  });

  it('keeps same-site assets only, strips cache-buster params and fragments, keeps version params', () => {
    const html = `<html><head>
      <meta name="generator" content="WordPress 6.4">
      <script src="https://unpeg.io/a.js?v=abc123&t=999"></script>
      <script src="https://cdn.unpeg.io/b.js?_=1&dpl=dpl_x#frag"></script>
      <script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
      <script src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script>
      <link rel="stylesheet" href="/s.css?TS=5&cb=2">
      <link rel="modulepreload" href="/m.js?rand=1&r=2&nocache&timestamp=3">
      <script src="/c.js?v=1&t=2&x=3"></script>
      <script src="https://evilunpeg.io/x.js"></script>
    </head><body></body></html>`;
    const fp = fingerprintFromPage(parseHtml(html, 'https://unpeg.io/'), 'unpeg.io', 1);
    expect(fp.assets).toEqual([
      'https://cdn.unpeg.io/b.js?dpl=dpl_x',
      'https://unpeg.io/a.js?v=abc123',
      'https://unpeg.io/c.js?v=1&x=3',
      'https://unpeg.io/m.js',
      'https://unpeg.io/s.css',
    ]);
    expect(fp.buildId).toBeNull();
    expect(fp.generator).toBe('WordPress 6.4');
    expect(fp.sig).toBe(sha1(`\n${fp.assets.join('\n')}`));
  });

  it('is independent of asset order', () => {
    const a = parseHtml('<script src="/a.js"></script><script src="/b.js"></script>', 'https://x.io/');
    const b = parseHtml('<script src="/b.js"></script><script src="/a.js"></script>', 'https://x.io/');
    expect(fingerprintFromPage(a, 'x.io', 1).sig).toBe(fingerprintFromPage(b, 'x.io', 2).sig);
  });

  it('has an empty signature when there is nothing to fingerprint', () => {
    expect(fingerprintFromPage(parseHtml('<html><body>Hello</body></html>', 'https://x.io/'), 'x.io', 1).sig).toBe('');
    const thirdParty = parseHtml('<script src="https://cdn.other.com/lib.js"></script>', 'https://x.io/');
    expect(fingerprintFromPage(thirdParty, 'x.io', 1)).toMatchObject({ assets: [], buildId: null, sig: '' });
  });

  it('uses a build id alone when there are no same-site assets', () => {
    const html = '<script id="__NEXT_DATA__" type="application/json">{"buildId":"abcdefgh1234","page":"/"}</script>';
    const fp = fingerprintFromPage(parseHtml(html, 'https://x.io/'), 'x.io', 1);
    expect(fp).toMatchObject({ assets: [], buildId: 'abcdefgh1234', sig: sha1('abcdefgh1234\n') });
  });

  it('fingerprintNoQuery drops every query string and dedupes', () => {
    const html = '<script src="/a.js?v=1"></script><script src="/a.js?v=2&nonce=9"></script><link rel="stylesheet" href="/s.css?h=1">';
    const parsed = parseHtml(html, 'https://x.io/');
    expect(fingerprintNoQuery(parsed, 'x.io', 1).assets).toEqual(['https://x.io/a.js', 'https://x.io/s.css']);
    expect(fingerprintFromPage(parsed, 'x.io', 1).assets).toHaveLength(3);
  });

  it('never throws on malformed input', () => {
    expect(fingerprintFromPage({} as ParsedPage, 'x.io', 1).sig).toBe('');
    expect(fingerprintFromPage(null as unknown as ParsedPage, 'x.io', 1).sig).toBe('');
    const junk = { assets: { scripts: [42, null, 'not a url', 'javascript:alert(1)', 'https://x.io/ok.js'], styles: 'x' } };
    expect(fingerprintFromPage(junk as unknown as ParsedPage, 'x.io', 1).assets).toEqual(['https://x.io/ok.js']);
    expect(fingerprintFromPage(junk as unknown as ParsedPage, '', 1).sig).toBe('');
  });
});

describe('isFlipFlop', () => {
  const now = 10_000_000;
  it('is false for a never-seen fingerprint or an empty sig', () => {
    expect(isFlipFlop([], 'a', now)).toBe(false);
    expect(isFlipFlop([{ sig: 'a', at: 1 }], 'b', now)).toBe(false);
    expect(isFlipFlop([{ sig: '', at: now }], '', now)).toBe(false);
  });

  it('is true when the fingerprint was current within the window', () => {
    const h = [
      { sig: 'old', at: 0 },
      { sig: 'new', at: now - 60_000 },
    ];
    expect(isFlipFlop(h, 'old', now)).toBe(true);
    expect(isFlipFlop(h, 'old', now - 60_000 + FLIP_FLOP_WINDOW_MS + 1)).toBe(false);
  });

  it('is true for a fingerprint that already became current twice', () => {
    const h = [
      { sig: 'a', at: 0 },
      { sig: 'b', at: 1 },
      { sig: 'a', at: 2 },
      { sig: 'c', at: 3 },
    ];
    expect(isFlipFlop(h, 'a', now)).toBe(true);
    expect(isFlipFlop(h, 'b', now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkDeploy against a local fake site
// ---------------------------------------------------------------------------

let site: FakeSite;
let h: Harness;
let homeHtml: string | (() => string);

function serveBundles(html: string, js: (path: string) => string = () => DEFAULT_JS): void {
  const parsed = parseHtml(html, site.url('/'));
  for (const u of [...parsed.assets.scripts, ...parsed.assets.preloads, ...parsed.assets.styles]) {
    const path = new URL(u).pathname;
    if (site.routes.has(path)) continue;
    site.routes.set(
      path,
      path.endsWith('.css')
        ? { status: 200, headers: { 'content-type': 'text/css' }, body: 'body{margin:0}' }
        : { status: 200, headers: { 'content-type': 'application/javascript' }, body: js(path) },
    );
  }
}

function setup(features: Partial<WatchFeatures> = {}): void {
  h = makeHarness({ url: site.url('/'), features });
}

async function baseline(): Promise<DeployCheckResult> {
  h.ctx.baseline = true;
  try {
    return await checkDeploy(h.ctx, await fetchHome(h.ctx));
  } finally {
    h.ctx.baseline = false;
  }
}

async function check(advanceMs = 30_000): Promise<DeployCheckResult> {
  h.advance(advanceMs);
  return checkDeploy(h.ctx, await fetchHome(h.ctx));
}

const chunkPaths = () =>
  parseHtml(FIXTURE, 'http://x/').assets.scripts.map((u) => new URL(u).pathname);

beforeEach(async () => {
  site = await startFakeSite();
  homeHtml = FIXTURE;
  site.routes.set('/', () => ({
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: typeof homeHtml === 'function' ? homeHtml() : homeHtml,
  }));
  serveBundles(FIXTURE);
  setup();
});

afterEach(async () => {
  h.close();
  await site.close();
});

describe('checkDeploy: baseline & steady state', () => {
  it('stores the baseline fingerprint silently and analyzes the bundles once', async () => {
    const r = await baseline();
    expect(r).toMatchObject({ changed: false, alert: null, newCodePaths: [] });
    const st = h.ctx.state;
    expect(st.deploy?.buildId).toBe(OLD_BUILD);
    expect(st.deploy?.assets).toHaveLength(9);
    expect(st.deployHistory).toEqual([{ sig: st.deploy!.sig, at: h.clock.now }]);
    expect(st.codePaths).toEqual(expect.arrayContaining(['/docs/how-it-works', '/app']));
    expect(st.codeHosts).toEqual(expect.arrayContaining(['rpc.unpeg.io', 'unpeg.io', 'x.com', 'dexscreener.com']));
    expect(r.hosts).toEqual(expect.arrayContaining(['rpc.unpeg.io', 'x.com']));
    expect(r.hosts).toEqual([...r.hosts].sort());
    for (const p of chunkPaths()) expect(site.hitCount(p)).toBe(1);
    expect(site.hitCount('/_next/static/chunks/0--9-y9nvg2ye.css')).toBe(0);
    expect(h.store.getJsAnalysis(site.url(`/_next/static/chunks/${OLD_CHUNK}`))?.paths).toContain('/app');
  });

  it('stays silent on a stable site over many checks (no confirm fetches, no bundle refetches)', async () => {
    await baseline();
    for (let i = 0; i < 20; i++) {
      const r = await check();
      expect(r.changed).toBe(false);
      expect(r.alert).toBeNull();
      expect(r.hosts).toContain('rpc.unpeg.io');
    }
    expect(site.hitCount('/')).toBe(21);
    for (const p of chunkPaths()) expect(site.hitCount(p)).toBe(1);
    expect(h.ctx.state.deployHistory).toHaveLength(1);
    expect(h.ctx.state.lastChangeAt).toBe(0);
  });

  it('stores the first fingerprint silently outside baseline mode too', async () => {
    const r = await check();
    expect(r.alert).toBeNull();
    expect(h.ctx.state.deploy?.buildId).toBe(OLD_BUILD);
  });

  it('is a no-op when the homepage was not a parsed HTML page', async () => {
    const r = await checkDeploy(h.ctx, { fetch: fakeFetch(502), parsed: null });
    expect(r).toEqual({ changed: false, alert: null, hosts: [], backfillHosts: [], newCodePaths: [] });
    expect(h.ctx.state.deploy).toBeNull();
    expect(site.requests).toHaveLength(0);
  });
});

describe('checkDeploy: redeploys', () => {
  it('alerts on an asset hash + build id change, confirmed by a second fetch', async () => {
    await baseline();
    const oldSig = h.ctx.state.deploy!.sig;
    homeHtml = deployHtml();
    serveBundles(homeHtml);
    const r = await check();
    expect(r.changed).toBe(true);
    expect(r.alert).toEqual({
      kind: 'deploy',
      url: site.url('/'),
      host: '127.0.0.1',
      buildIdOld: OLD_BUILD,
      buildIdNew: NEW_BUILD,
      assetsAdded: [`/_next/static/chunks/${NEW_CHUNK}`],
      assetsRemoved: [`/_next/static/chunks/${OLD_CHUNK}`],
      newCodePaths: [],
      newCodeHosts: [],
    });
    expect(site.hitCount('/')).toBe(3); // baseline + check + confirm
    expect(h.sleeps).toEqual([0]);
    const st = h.ctx.state;
    expect(st.deploy?.buildId).toBe(NEW_BUILD);
    expect(st.deploy?.sig).not.toBe(oldSig);
    expect(st.lastChangeAt).toBe(h.clock.now);
    expect(st.deployHistory.map((e) => e.sig)).toEqual([oldSig, st.deploy!.sig]);
    // Only the new bundle was fetched.
    expect(site.hitCount(`/_next/static/chunks/${NEW_CHUNK}`)).toBe(1);

    for (let i = 0; i < 5; i++) expect((await check()).alert).toBeNull();
  });

  it('ignores a rolling deploy when the confirm fetch still returns the old build', async () => {
    await baseline();
    const oldSig = h.ctx.state.deploy!.sig;
    // This tick's homepage fetch hit an updated edge; the server (confirm fetch) still serves the old build.
    h.advance(30_000);
    const r = await checkDeploy(h.ctx, homeFromHtml(deployHtml(), site.url('/')));
    expect(r).toMatchObject({ changed: false, alert: null });
    expect(h.ctx.state.deploy?.sig).toBe(oldSig);
    expect(h.ctx.state.deployHistory).toHaveLength(1);
    expect(site.hitCount('/')).toBe(2);
  });

  it('does not alert when the confirm fetch fails', async () => {
    await baseline();
    const oldSig = h.ctx.state.deploy!.sig;
    let n = 0;
    site.routes.set('/', () =>
      ++n === 1
        ? { status: 200, headers: { 'content-type': 'text/html' }, body: deployHtml() }
        : { status: 500, body: 'error' },
    );
    const r = await check();
    expect(r.alert).toBeNull();
    expect(h.ctx.state.deploy?.sig).toBe(oldSig);
  });

  it('suppresses flip-flops between two builds within 15 minutes (one alert only)', async () => {
    serveBundles(deployHtml());
    await baseline();
    const alerts: DeployCheckResult[] = [];
    const flip = async (html: string) => {
      homeHtml = html;
      const r = await check(60_000);
      if (r.alert) alerts.push(r);
      return r;
    };
    await flip(deployHtml());
    await flip(FIXTURE);
    await flip(deployHtml());
    await flip(FIXTURE);
    await flip(deployHtml());
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alert?.buildIdNew).toBe(NEW_BUILD);
    expect(h.ctx.state.deploy?.buildId).toBe(NEW_BUILD);
    expect(h.ctx.state.deployHistory.length).toBeLessThanOrEqual(10);
  });

  it('reports a rollback long after the deploy, but not an immediate re-flip', async () => {
    serveBundles(deployHtml());
    await baseline();
    homeHtml = deployHtml();
    expect((await check()).alert).not.toBeNull();
    for (let i = 0; i < 4; i++) await check(10 * 60_000); // 40 minutes on the new build
    homeHtml = FIXTURE;
    const rollback = await check();
    expect(rollback.alert).toMatchObject({ buildIdOld: NEW_BUILD, buildIdNew: OLD_BUILD });
    homeHtml = deployHtml();
    expect((await check(60_000)).alert).toBeNull();
  });

  it('never alerts on a per-request ?t= cache buster', async () => {
    homeHtml = () =>
      `<html><head><script src="/app.js?t=${Math.random()}"></script>` +
      `<link rel="stylesheet" href="/app.css?v=3&_=${Date.now()}${Math.random()}"></head><body>hello</body></html>`;
    site.routes.set('/app.js', { status: 200, headers: { 'content-type': 'text/javascript' }, body: DEFAULT_JS });
    await baseline();
    for (let i = 0; i < 15; i++) expect((await check()).alert).toBeNull();
    expect(site.hitCount('/')).toBe(16); // never needed a confirm fetch
    expect(h.ctx.state.deploy?.assets).toEqual([site.url('/app.css?v=3'), site.url('/app.js')]);
  });

  it('learns unknown per-request query params after one confirm, and still detects real deploys', async () => {
    let name = 'app';
    homeHtml = () => `<html><head><script src="/${name}.js?nonce=${Math.random()}"></script></head><body>hi</body></html>`;
    site.routes.set('/app.js', { status: 200, headers: { 'content-type': 'text/javascript' }, body: '"/one"' });
    site.routes.set('/app2.js', { status: 200, headers: { 'content-type': 'text/javascript' }, body: '"/one";"/two"' });
    await baseline();
    expect((await check()).alert).toBeNull();
    expect(site.hitCount('/')).toBe(3); // check + one confirm
    for (let i = 0; i < 5; i++) expect((await check()).alert).toBeNull();
    expect(site.hitCount('/')).toBe(8); // no more confirm fetches

    name = 'app2';
    const r = await check();
    expect(r.changed).toBe(true);
    expect(r.alert).toMatchObject({ assetsAdded: ['/app2.js'], assetsRemoved: ['/app.js'], newCodePaths: ['/two'] });
    for (let i = 0; i < 3; i++) expect((await check()).alert).toBeNull();
  });

  it('never alerts for a site with no assets and no build id', async () => {
    let n = 0;
    homeHtml = () => `<html><body><h1>Hello ${++n}</h1><script>window.x=${n}</script></body></html>`;
    await baseline();
    expect(h.ctx.state.deploy?.sig).toBe('');
    for (let i = 0; i < 5; i++) expect((await check()).alert).toBeNull();
    expect(site.hitCount('/')).toBe(6);
  });

  it('keeps the real fingerprint while an asset-less maintenance page is served', async () => {
    await baseline();
    const sig = h.ctx.state.deploy!.sig;
    homeHtml = '<html><body>Down for maintenance</body></html>';
    expect((await check()).alert).toBeNull();
    expect(h.ctx.state.deploy?.sig).toBe(sig);
    homeHtml = FIXTURE;
    expect((await check()).alert).toBeNull();
    expect(site.hitCount('/')).toBe(3); // no confirm fetches at all
  });
});

describe('checkDeploy: code intel', () => {
  it('reports new routes and hosts introduced by new bundles, without refetching cached ones', async () => {
    h.store.upsertPage({ ...fileRecord(h.watch.id, site.url('/about')), kind: 'page' });
    await baseline();
    homeHtml = deployHtml();
    serveBundles(homeHtml, (path) =>
      path.endsWith(NEW_CHUNK)
        ? 'const r=["/airdrop","/about","/docs/how-it-works"];fetch("https://api.unpeg.io/v1/claim");'
        : DEFAULT_JS,
    );
    const r = await check();
    expect(r.alert?.newCodePaths).toEqual(['/airdrop']);
    expect(r.alert?.newCodeHosts).toEqual(['api.unpeg.io']);
    expect(r.newCodePaths).toEqual(['/airdrop']);
    expect(r.hosts).toEqual(expect.arrayContaining(['api.unpeg.io', 'rpc.unpeg.io', 'x.com']));
    for (const p of chunkPaths()) expect(site.hitCount(p)).toBe(1);
    expect(site.hitCount(`/_next/static/chunks/${NEW_CHUNK}`)).toBe(1);
    expect(h.ctx.state.codePaths).toEqual(expect.arrayContaining(['/airdrop', '/about', '/app']));
    expect(h.ctx.state.codeHosts).toContain('api.unpeg.io');

    // A later deploy that keeps those references does not report them again.
    homeHtml = deployHtml('7another0000.js', 'ThirdBuild_000001');
    serveBundles(homeHtml, () => 'const r=["/airdrop"];fetch("https://api.unpeg.io/v1/claim");');
    const r2 = await check();
    expect(r2.alert).toMatchObject({ newCodePaths: [], newCodeHosts: [], buildIdNew: 'ThirdBuild_000001' });
  });

  it('does not fetch bundles when code intel is disabled', async () => {
    setup({ codeIntel: false });
    await baseline();
    homeHtml = deployHtml();
    serveBundles(homeHtml);
    const r = await check();
    expect(r.alert).toMatchObject({ newCodePaths: [], newCodeHosts: [] });
    for (const p of [...chunkPaths(), `/_next/static/chunks/${NEW_CHUNK}`]) expect(site.hitCount(p)).toBe(0);
    expect(h.ctx.state.codePaths).toEqual([]);
  });

  it('with deploy alerts off, only alerts when a deploy brings new code references', async () => {
    setup({ deploy: false });
    await baseline();
    homeHtml = deployHtml();
    serveBundles(homeHtml);
    const quiet = await check();
    expect(quiet).toMatchObject({ changed: true, alert: null });

    homeHtml = deployHtml('8third000000.js', 'ThirdBuild_000001');
    serveBundles(homeHtml, () => '["/launch"]');
    const loud = await check();
    expect(loud.alert).toMatchObject({ kind: 'deploy', newCodePaths: ['/launch'] });
  });

  it('back-fills bundles that failed to load, so their routes are never reported as new later', async () => {
    const flaky = `/_next/static/chunks/${OLD_CHUNK}`;
    site.routes.set(flaky, { status: 500, body: 'error' });
    await baseline();
    expect(h.ctx.state.codePaths).not.toContain('/secret-old');
    site.routes.set(flaky, { status: 200, headers: { 'content-type': 'text/javascript' }, body: '["/secret-old"]' });

    await check();
    expect(site.hitCount(flaky)).toBe(1); // retry backoff
    await check(11 * 60_000);
    expect(site.hitCount(flaky)).toBe(2);
    expect(h.ctx.state.codePaths).toContain('/secret-old');
    await check();
    expect(site.hitCount(flaky)).toBe(2);

    homeHtml = deployHtml();
    serveBundles(homeHtml, (p) => (p.endsWith(NEW_CHUNK) ? '["/secret-old","/brand-new"]' : DEFAULT_JS));
    const r = await check();
    expect(r.alert?.newCodePaths).toEqual(['/brand-new']);
  });

  it('never mines an HTML fallback page as code', async () => {
    homeHtml = deployHtml();
    site.routes.set(`/_next/static/chunks/${NEW_CHUNK}`, {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html><html><body><a href="/not-code">x</a><script>"/not-code"</script></body></html>',
    });
    await baseline();
    expect(h.ctx.state.codePaths).not.toContain('/not-code');
    expect(h.store.getJsAnalysis(site.url(`/_next/static/chunks/${NEW_CHUNK}`))).toBeUndefined();
  });
});

describe('checkDeploy: per-node variants, platforms and backfill hosts', () => {
  /** Two backend nodes serving the same files with different "?ver=<mtime>" values. */
  const wpHtml = (ver: string) =>
    `<html><head><meta name="generator" content="WordPress 6.8">` +
    `<link rel="stylesheet" href="/wp-content/themes/news/style.css?ver=${ver}">` +
    `<script src="/wp-content/blocks/view.js?ver=${ver}"></script></head><body>News</body></html>`;

  function serveWp(): void {
    site.routes.set('/wp-content/blocks/view.js', { status: 200, headers: { 'content-type': 'text/javascript' }, body: DEFAULT_JS });
    site.routes.set('/wp-content/themes/news/style.css', { status: 200, headers: { 'content-type': 'text/css' }, body: 'a{}' });
  }

  it('two per-node ?ver= variants alert at most once, also after a restart and past the flip-flop window', async () => {
    serveWp();
    let ver = '1781190440';
    homeHtml = () => wpHtml(ver);
    await baseline();
    let alerts = 0;
    for (let i = 0; i < 6; i++) {
      ver = i % 2 === 0 ? '1781196563' : '1781190440';
      if ((await check(5 * 60_000)).alert) alerts++;
    }
    expect(alerts).toBeLessThanOrEqual(1);

    // Restart: runtime memory is gone, the persisted state is reloaded; the next switch is far outside 15 minutes.
    h.store.saveState(h.watch.id, h.ctx.state);
    h.ctx.state = h.store.getState(h.watch.id);
    for (let i = 0; i < 4; i++) {
      ver = i % 2 === 0 ? '1781190440' : '1781196563';
      expect((await check(FLIP_FLOP_WINDOW_MS + 60_000)).alert).toBeNull();
    }

    // A never-seen version of the same files is a real (WordPress) deploy.
    ver = '1790000001';
    expect((await check()).alert).toMatchObject({ kind: 'deploy' });
  });

  it('one asset with a per-request ?v= does not blind query-versioned deploy detection for the others', async () => {
    serveWp();
    site.routes.set('/widget.js', { status: 200, headers: { 'content-type': 'text/javascript' }, body: '1' });
    let ver = '1.0.0';
    homeHtml = () =>
      `<html><head><link rel="stylesheet" href="/wp-content/themes/news/style.css?ver=${ver}">` +
      `<script src="/wp-content/blocks/view.js?ver=${ver}"></script>` +
      `<script src="/widget.js?v=${Math.random().toString(36).slice(2)}"></script></head><body>x</body></html>`;
    await baseline();
    for (let i = 0; i < 4; i++) expect((await check()).alert).toBeNull();
    expect(h.ctx.state.unstableQueryPaths).toEqual([site.url('/widget.js')]);
    ver = '1.1.0';
    const r = await check();
    expect(r.alert).toMatchObject({ kind: 'deploy' });
    expect(r.alert!.assetsAdded).toEqual(expect.arrayContaining(['/wp-content/blocks/view.js?ver=1.1.0']));
    for (let i = 0; i < 3; i++) expect((await check()).alert).toBeNull();
  });

  const mintlifyHtml = (dpl: string, build: string, custom = '') =>
    `<html><head><meta name="generator" content="Mintlify">` +
    `<script src="/mintlify-assets/_next/static/chunks/44795504c795ca32.js?dpl=${dpl}"></script>` +
    `<link rel="stylesheet" href="/mintlify-assets/_next/static/css/app.css?dpl=${dpl}">${custom}` +
    `<script id="__NEXT_DATA__" type="application/json">{"buildId":"${build}","page":"/"}</script></head><body>Docs</body></html>`;

  it('a hosted docs platform (Mintlify) is not fingerprinted: platform releases are not the site redeploying', async () => {
    const fp = fingerprintFromPage(parseHtml(mintlifyHtml('dpl_A', 'VELzMKQ865M'), site.url('/')), '127.0.0.1', 1);
    expect(fp).toMatchObject({ assets: [], buildId: null, sig: '' });

    homeHtml = mintlifyHtml('dpl_A', 'VELzMKQ865M');
    await baseline();
    homeHtml = mintlifyHtml('dpl_B', 'Other000Build');
    expect((await check()).alert).toBeNull();

    // A customer's own script still fingerprints.
    site.routes.set('/custom.js', { status: 200, headers: { 'content-type': 'text/javascript' }, body: '1' });
    site.routes.set('/custom2.js', { status: 200, headers: { 'content-type': 'text/javascript' }, body: '2' });
    homeHtml = mintlifyHtml('dpl_B', 'Other000Build', '<script src="/custom.js?h=aaa111"></script>');
    await check(); // first real fingerprint (was empty)
    homeHtml = mintlifyHtml('dpl_C', 'Third00Build', '<script src="/custom.js?h=bbb222"></script>');
    expect((await check()).alert).toMatchObject({ kind: 'deploy', assetsAdded: ['/custom.js?h=bbb222'] });
  });

  it('a fingerprint stored before platform assets were excluded does not look like a deploy', async () => {
    homeHtml = mintlifyHtml('dpl_A', 'VELzMKQ865M', '<script src="/custom.js?h=aaa"></script>');
    site.routes.set('/custom.js', { status: 200, headers: { 'content-type': 'text/javascript' }, body: '1' });
    await baseline();
    // Simulate the old rules: platform assets and build id in the stored fingerprint.
    const old = h.ctx.state.deploy!;
    const assets = [...old.assets, site.url('/mintlify-assets/_next/static/chunks/44795504c795ca32.js?dpl=dpl_A')].sort();
    h.ctx.state.deploy = { ...old, assets, buildId: 'VELzMKQ865M', sig: sha1(`VELzMKQ865M\n${assets.join('\n')}`) };
    expect((await check()).alert).toBeNull();
    expect(site.hitCount('/')).toBe(2); // no confirm fetch was even needed
  });

  it('hosts found while back-filling a bundle that failed at the baseline are returned as backfill (quiet) hosts', async () => {
    const flaky = `/_next/static/chunks/${OLD_CHUNK}`;
    site.routes.set(flaky, { status: 503, body: 'busy' });
    await baseline();
    site.routes.set(flaky, { status: 200, headers: { 'content-type': 'text/javascript' }, body: 'fetch("https://rpc-internal.unpeg.io/x")' });
    const r = await check(11 * 60_000);
    expect(r.backfillHosts).toContain('rpc-internal.unpeg.io');
    expect(r.hosts).not.toContain('rpc-internal.unpeg.io');
    // Known from then on: an ordinary later check lists it as a normal code host.
    expect((await check()).hosts).toContain('rpc-internal.unpeg.io');
  });
});
