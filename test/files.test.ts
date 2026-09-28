import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHURN_LIMIT,
  DYNAMIC_AFTER_FLAPS,
  DYNAMIC_RESET_MS,
  GONE_RECHECK_MS,
  MAX_FILES_PER_TICK,
  MAX_TRACKED_FILES,
  checkFiles,
} from '../src/monitor/files.js';
import { sha1 } from '../src/diff/text.js';
import type { FileAlert, PageRecord } from '../src/types.js';
import {
  fileRecord,
  makeHarness,
  startFakeSite,
  START_TIME,
  type FakeSite,
  type Harness,
} from './helpers/core-monitor-harness.js';

const SWEEP_MS = 120_000;
let site: FakeSite;
let h: Harness;

beforeEach(async () => {
  site = await startFakeSite();
  h = makeHarness({ url: site.url('/') });
  // Baseline completed just before START_TIME; records default to firstSeen = START_TIME - 1000 (seen during baseline).
  h.ctx.state.baselineAt = START_TIME - 500;
});

afterEach(async () => {
  h.close();
  await site.close();
});

function addFile(path: string, over: Partial<PageRecord> = {}): string {
  const url = site.url(path);
  h.store.upsertPage(fileRecord(h.watch.id, url, over));
  return url;
}

function rec(url: string): PageRecord {
  const r = h.store.getPage(h.watch.id, url);
  if (!r) throw new Error(`missing record ${url}`);
  return r;
}

/** Advance a full sweep period and run a normal check. */
async function sweep(full = false): Promise<FileAlert[]> {
  h.advance(SWEEP_MS);
  return checkFiles(h.ctx, { full });
}

const PDF_V1 = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 1), Buffer.from('\n%%EOF')]);
const PDF_V2 = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(3500, 2), Buffer.from('\n%%EOF')]);

function servePdf(path: string, body: () => Buffer, headers: () => Record<string, string> = () => ({})) {
  site.routes.set(path, () => ({ status: 200, headers: { 'content-type': 'application/pdf', ...headers() }, body: body() }));
}

describe('checkFiles: baseline & new files', () => {
  it('records files silently in baseline mode', async () => {
    const url = addFile('/whitepaper.pdf');
    servePdf('/whitepaper.pdf', () => PDF_V1, () => ({ etag: '"v1"', 'last-modified': 'Mon, 01 Sep 2025 00:00:00 GMT' }));
    h.ctx.baseline = true;
    h.ctx.state.baselineAt = 0;
    expect(await checkFiles(h.ctx, { full: true })).toEqual([]);
    const r = rec(url);
    expect(r).toMatchObject({
      textHash: sha1(PDF_V1),
      contentLength: PDF_V1.length,
      contentType: 'application/pdf',
      etag: '"v1"',
      lastModified: 'Mon, 01 Sep 2025 00:00:00 GMT',
      status: 200,
      lastChecked: h.clock.now,
      failCount: 0,
      gone: false,
    });
  });

  it('first fetch of a file seen during the baseline is silent', async () => {
    const url = addFile('/terms.pdf', { firstSeen: START_TIME - 10_000 });
    servePdf('/terms.pdf', () => PDF_V1);
    expect(await sweep()).toEqual([]);
    expect(rec(url).textHash).toBe(sha1(PDF_V1));
  });

  it('reports a file first seen after the baseline as added', async () => {
    const url = addFile('/docs/litepaper.pdf', { firstSeen: START_TIME + 5 });
    servePdf('/docs/litepaper.pdf', () => PDF_V2);
    expect(await sweep()).toEqual([
      {
        kind: 'file',
        files: [{ url, change: 'added', oldSize: null, newSize: PDF_V2.length, contentType: 'application/pdf' }],
      },
    ]);
    expect(rec(url).lastChanged).toBe(h.clock.now);
    expect(h.ctx.state.lastChangeAt).toBe(h.clock.now);
    // And it is not reported again.
    expect(await sweep()).toEqual([]);
  });

  it('returns [] and fetches nothing when features.files is off', async () => {
    addFile('/a.pdf');
    servePdf('/a.pdf', () => PDF_V1);
    h.ctx.watch = { ...h.ctx.watch, features: { ...h.ctx.watch.features, files: false } };
    expect(await sweep(true)).toEqual([]);
    expect(site.hitCount('/a.pdf')).toBe(0);
  });
});

describe('checkFiles: change detection', () => {
  it('ignores a changing weak ETag when the bytes are identical', async () => {
    const url = addFile('/whitepaper.pdf', { textHash: sha1(PDF_V1), etag: 'W/"1"', contentLength: PDF_V1.length });
    let n = 1;
    // A server that ignores If-None-Match and hands out a new weak ETag every time.
    servePdf('/whitepaper.pdf', () => PDF_V1, () => ({ etag: `W/"${++n}"` }));
    for (let i = 0; i < 5; i++) expect(await sweep()).toEqual([]);
    const r = rec(url);
    expect(r.textHash).toBe(sha1(PDF_V1));
    expect(r.etag).toBe(`W/"${n}"`);
    // Only one fetch per check (no confirm fetches for unchanged bytes).
    expect(site.hitCount('/whitepaper.pdf')).toBe(5);
    // The stored validator is sent back.
    expect(site.requests.at(-1)?.headers['if-none-match']).toBe(`W/"${n - 1}"`);
  });

  it('reports modified bytes with old and new sizes after a confirm fetch', async () => {
    const url = addFile('/whitepaper.pdf');
    let body = PDF_V1;
    servePdf('/whitepaper.pdf', () => body, () => ({ etag: `"${sha1(body).slice(0, 8)}"` }));
    expect(await sweep()).toEqual([]);
    body = PDF_V2;
    const hitsBefore = site.hitCount('/whitepaper.pdf');
    const alerts = await sweep();
    expect(alerts).toEqual([
      {
        kind: 'file',
        files: [{ url, change: 'modified', oldSize: PDF_V1.length, newSize: PDF_V2.length, contentType: 'application/pdf' }],
      },
    ]);
    expect(site.hitCount('/whitepaper.pdf') - hitsBefore).toBe(2);
    expect(h.sleeps).toContain(0);
    expect(rec(url)).toMatchObject({ textHash: sha1(PDF_V2), contentLength: PDF_V2.length, lastChanged: h.clock.now });
    expect(await sweep()).toEqual([]);
  });

  it('uses conditional requests: 304 means unchanged', async () => {
    const url = addFile('/notes.txt', { textHash: sha1('hello'), etag: '"abc"', lastModified: 'Mon, 01 Sep 2025 00:00:00 GMT', contentLength: 5 });
    site.routes.set('/notes.txt', (req) =>
      req.headers['if-none-match'] === '"abc"'
        ? { status: 304 }
        : { status: 200, headers: { 'content-type': 'text/plain', etag: '"abc"' }, body: 'hello' },
    );
    expect(await sweep()).toEqual([]);
    const last = site.requests.at(-1)!;
    expect(last.headers['if-none-match']).toBe('"abc"');
    expect(last.headers['if-modified-since']).toBe('Mon, 01 Sep 2025 00:00:00 GMT');
    expect(rec(url)).toMatchObject({ status: 304, lastChecked: h.clock.now, textHash: sha1('hello'), contentLength: 5 });
  });

  it('never sends validators before content was hashed', async () => {
    addFile('/x.txt', { etag: '"stale"', lastModified: 'Mon, 01 Sep 2025 00:00:00 GMT' });
    site.routes.set('/x.txt', () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'x' }));
    await sweep();
    expect(site.requests.at(-1)?.headers['if-none-match']).toBeUndefined();
    expect(site.requests.at(-1)?.headers['if-modified-since']).toBeUndefined();
  });

  it('ignores a transient change when the confirm fetch returns the old bytes', async () => {
    const url = addFile('/whitepaper.pdf', { textHash: sha1(PDF_V1), etag: '"v1"', contentLength: PDF_V1.length });
    let call = 0;
    site.routes.set('/whitepaper.pdf', () => {
      call++;
      const body = call === 1 ? PDF_V2 : PDF_V1;
      return { status: 200, headers: { 'content-type': 'application/pdf', etag: call === 1 ? '"v2"' : '"v1"' }, body };
    });
    expect(await sweep()).toEqual([]);
    expect(call).toBe(2);
    // Old hash AND old validators kept, so the next conditional request cannot hide a real change.
    expect(rec(url)).toMatchObject({ textHash: sha1(PDF_V1), etag: '"v1"' });
  });

  it('marks a file that differs on every request dynamic without alerting', async () => {
    const url = addFile('/live.json', { textHash: sha1('{"n":0}'), contentLength: 7 });
    let n = 0;
    site.routes.set('/live.json', () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: `{"n":${++n}}` }));
    for (let i = 0; i < DYNAMIC_AFTER_FLAPS; i++) expect(await sweep()).toEqual([]);
    expect(rec(url)).toMatchObject({ dynamic: true, flapCount: DYNAMIC_AFTER_FLAPS, textHash: sha1('{"n":0}') });
    // Dynamic files are only re-checked hourly and never alert.
    const hits = site.hitCount('/live.json');
    expect(await sweep()).toEqual([]);
    expect(site.hitCount('/live.json')).toBe(hits);
    h.advance(60 * 60_000);
    expect(await sweep()).toEqual([]);
    expect(site.hitCount('/live.json')).toBe(hits + 1);
  });

  it(`stops alerting after ${CHURN_LIMIT} confirmed changes within an hour, and trusts the file again later`, async () => {
    const url = addFile('/data.csv', { textHash: sha1('v0'), contentLength: 2 });
    let version = 0;
    site.routes.set('/data.csv', () => ({ status: 200, headers: { 'content-type': 'text/csv' }, body: `v${version}` }));
    let alerts = 0;
    for (let i = 1; i <= CHURN_LIMIT + 3; i++) {
      version = i;
      alerts += (await sweep()).length;
    }
    expect(alerts).toBe(CHURN_LIMIT);
    expect(rec(url).dynamic).toBe(true);

    // The hourly re-check of a dynamic file records changes silently.
    h.advance(60 * 60_000);
    expect(await sweep()).toEqual([]);
    expect(rec(url)).toMatchObject({ dynamic: true, textHash: sha1(`v${CHURN_LIMIT + 3}`) });

    // A day without changes → trusted again.
    h.advance(DYNAMIC_RESET_MS + 60_000);
    expect(await sweep()).toEqual([]);
    expect(rec(url)).toMatchObject({ dynamic: false, flapCount: 0, numericChangeTimes: [] });
    version = 100;
    const out = await sweep();
    expect(out).toHaveLength(1);
    expect(out[0].files[0]).toMatchObject({ change: 'modified', oldSize: 2, newSize: 4 });
  });

  it('hashes a truncated (oversize) body by prefix + declared length', async () => {
    h.ctx.config = { ...h.ctx.config, maxFileBytes: 1024 };
    const big = Buffer.alloc(5000, 7);
    const url = addFile('/big.pdf');
    let n = 0;
    let body = big;
    // Validators that change every time must not matter for a truncated body.
    servePdf('/big.pdf', () => body, () => ({ etag: `"${++n}"`, 'last-modified': new Date(START_TIME + n * 1000).toUTCString() }));
    expect(await sweep()).toEqual([]);
    const expected = sha1(`len:5000|prefix:${sha1(big.subarray(0, 1024))}`);
    expect(rec(url)).toMatchObject({ textHash: expected, contentLength: 5000 });
    expect(await sweep()).toEqual([]);
    expect(rec(url).textHash).toBe(expected);

    body = Buffer.alloc(6000, 7);
    const alerts = await sweep();
    expect(alerts[0].files[0]).toMatchObject({ url, change: 'modified', oldSize: 5000, newSize: 6000 });
  });
});

describe('checkFiles: removal', () => {
  it('reports a file removed after two 404s', async () => {
    const url = addFile('/whitepaper.pdf', { textHash: sha1(PDF_V1), contentLength: PDF_V1.length, contentType: 'application/pdf' });
    expect(await sweep()).toEqual([]); // no route → 404
    expect(rec(url)).toMatchObject({ failCount: 1, gone: false, status: 404 });
    expect(await sweep()).toEqual([
      {
        kind: 'file',
        files: [{ url, change: 'removed', oldSize: PDF_V1.length, newSize: null, contentType: 'application/pdf' }],
      },
    ]);
    expect(rec(url)).toMatchObject({ failCount: 2, gone: true });
    // Gone files are not reported again (and only re-checked hourly).
    expect(await sweep()).toEqual([]);
    expect(await sweep(true)).toEqual([]);
  });

  it('treats 410 like 404', async () => {
    const url = addFile('/old.pdf', { textHash: sha1(PDF_V1) });
    site.routes.set('/old.pdf', { status: 410, body: 'gone' });
    await sweep();
    const alerts = await sweep();
    expect(alerts[0].files[0]).toMatchObject({ url, change: 'removed' });
  });

  it('does not count two misses a few seconds apart twice', async () => {
    const url = addFile('/whitepaper.pdf', { textHash: sha1(PDF_V1) });
    expect(await sweep()).toEqual([]);
    h.advance(5_000);
    expect(await checkFiles(h.ctx, { full: true })).toEqual([]);
    expect(rec(url).failCount).toBe(1);
    expect((await sweep())[0].files[0].change).toBe('removed');
  });

  it('marks a dead link gone silently (a file never seen cannot be "removed")', async () => {
    const url = addFile('/coming-soon.pdf');
    expect(await sweep()).toEqual([]);
    expect(await sweep()).toEqual([]);
    expect(rec(url)).toMatchObject({ gone: true, textHash: null });
  });

  it('reports a dead link that finally gets its file as added', async () => {
    const url = addFile('/coming-soon.pdf');
    await sweep();
    await sweep();
    expect(rec(url).gone).toBe(true);
    servePdf('/coming-soon.pdf', () => PDF_V1);
    expect(await sweep()).toEqual([]); // not due yet (gone files: hourly)
    h.advance(GONE_RECHECK_MS);
    const alerts = await sweep();
    expect(alerts).toEqual([
      { kind: 'file', files: [{ url, change: 'added', oldSize: null, newSize: PDF_V1.length, contentType: 'application/pdf' }] },
    ]);
    expect(rec(url)).toMatchObject({ gone: false, failCount: 0 });
  });

  it('restores a removed file silently when it comes back unchanged, and reports it when it comes back different', async () => {
    const a = addFile('/a.pdf', { textHash: sha1(PDF_V1), contentLength: PDF_V1.length });
    const b = addFile('/b.pdf', { textHash: sha1(PDF_V1), contentLength: PDF_V1.length });
    await sweep();
    const removed = await sweep();
    expect(removed[0].files.map((f) => f.change)).toEqual(['removed', 'removed']);
    servePdf('/a.pdf', () => PDF_V1);
    servePdf('/b.pdf', () => PDF_V2);
    const back = await sweep(true);
    expect(back).toEqual([
      { kind: 'file', files: [{ url: b, change: 'added', oldSize: PDF_V1.length, newSize: PDF_V2.length, contentType: 'application/pdf' }] },
    ]);
    expect(rec(a)).toMatchObject({ gone: false, failCount: 0 });
    expect(rec(b)).toMatchObject({ gone: false, textHash: sha1(PDF_V2) });
  });

  it('counts an HTML answer for a document URL (soft 404) as missing', async () => {
    const url = addFile('/whitepaper.pdf', { textHash: sha1(PDF_V1) });
    site.routes.set('/whitepaper.pdf', { status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><html><body>App</body></html>' });
    expect(await sweep()).toEqual([]);
    expect((await sweep())[0].files[0]).toMatchObject({ url, change: 'removed' });
  });

  it('ignores server errors and network failures', async () => {
    const url = addFile('/whitepaper.pdf', { textHash: sha1(PDF_V1), failCount: 1, lastChecked: START_TIME });
    site.routes.set('/whitepaper.pdf', { status: 500, body: 'oops' });
    expect(await sweep()).toEqual([]);
    expect(rec(url)).toMatchObject({ failCount: 1, gone: false, status: 500, textHash: sha1(PDF_V1), lastChecked: h.clock.now });

    const dead = site.url('/whitepaper.pdf').replace(/:\d+\//, ':1/');
    h.store.upsertPage(fileRecord(h.watch.id, dead, { textHash: 'x' }));
    expect(await sweep()).toEqual([]);
    expect(rec(dead)).toMatchObject({ status: 0, failCount: 0, gone: false, textHash: 'x' });
  });
});

describe('checkFiles: scheduling', () => {
  it('only checks due files, oldest first, at most MAX_FILES_PER_TICK', async () => {
    const urls: string[] = [];
    for (let i = 0; i < MAX_FILES_PER_TICK + 5; i++) {
      const path = `/f${i}.txt`;
      site.routes.set(path, { status: 200, headers: { 'content-type': 'text/plain' }, body: `file ${i}` });
      urls.push(addFile(path, { textHash: sha1(`file ${i}`), lastChecked: START_TIME - 1000 * (i + 1) }));
    }
    // Nothing is due within the sweep period.
    expect(await checkFiles(h.ctx, { full: false })).toEqual([]);
    expect(site.requests).toHaveLength(0);

    await sweep();
    expect(site.requests).toHaveLength(MAX_FILES_PER_TICK);
    // The oldest lastChecked (highest index) went first.
    const checked = new Set(site.requests.map((r) => r.path));
    for (let i = 5; i < MAX_FILES_PER_TICK + 5; i++) expect(checked.has(`/f${i}.txt`)).toBe(true);

    // The next tick picks up the remaining five.
    h.advance(1000);
    await checkFiles(h.ctx, { full: false });
    expect(site.requests).toHaveLength(MAX_FILES_PER_TICK + 5);

    // full → everything, regardless of due times.
    await checkFiles(h.ctx, { full: true });
    expect(site.requests).toHaveLength(2 * (MAX_FILES_PER_TICK + 5));
  });

  it(`checks at most ${MAX_TRACKED_FILES} files per full call, rotating so every tracked file is reached; skips untracked rows`, async () => {
    for (let i = 0; i < MAX_TRACKED_FILES + 3; i++) {
      addFile(`/doc${i}.md`, { firstSeen: START_TIME - 100_000 + i });
    }
    addFile('/untracked.md', { tracked: false });
    await checkFiles(h.ctx, { full: true });
    expect(site.requests).toHaveLength(MAX_TRACKED_FILES);
    expect(new Set(site.requests.map((r) => r.path)).has('/untracked.md')).toBe(false);
    h.advance(1000);
    await checkFiles(h.ctx, { full: true });
    const paths = new Set(site.requests.map((r) => r.path));
    for (let i = 0; i < MAX_TRACKED_FILES + 3; i++) expect(paths.has(`/doc${i}.md`)).toBe(true);
    expect(paths.has('/untracked.md')).toBe(false);
  });

  it('a newly linked document is checked (and reported) even when 100 older files exist', async () => {
    for (let i = 0; i < 100; i++) {
      const url = addFile(`/report-${i}.pdf`, { firstSeen: START_TIME - 100_000 + i, textHash: sha1(PDF_V1), lastChecked: START_TIME - 10_000 });
      site.routes.set(new URL(url).pathname, () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: PDF_V1 }));
    }
    const fresh = addFile('/whitepaper-v2.pdf', { firstSeen: START_TIME });
    servePdf('/whitepaper-v2.pdf', () => PDF_V2);
    h.advance(1000);
    const alerts = await checkFiles(h.ctx, { full: false });
    expect(alerts).toEqual([
      { kind: 'file', files: [{ url: fresh, change: 'added', oldSize: null, newSize: PDF_V2.length, contentType: 'application/pdf' }] },
    ]);
  });

  it('never-checked documents come before never-checked markdown files', async () => {
    for (let i = 0; i < 150; i++) addFile(`/docs/page-${i}.md`, { firstSeen: START_TIME - 100_000 + i });
    addFile('/a3f91c2d-v2.pdf', { firstSeen: START_TIME });
    servePdf('/a3f91c2d-v2.pdf', () => PDF_V1);
    await checkFiles(h.ctx, { full: false });
    expect(site.requests.map((r) => r.path)).toContain('/a3f91c2d-v2.pdf');
    expect(rec(site.url('/a3f91c2d-v2.pdf')).textHash).toBe(sha1(PDF_V1));
  });

  it('a silent pass (settings change) records new files without "added" alerts', async () => {
    const url = addFile('/whitepaper.pdf', { firstSeen: START_TIME + 10 });
    servePdf('/whitepaper.pdf', () => PDF_V1);
    h.advance(1000);
    h.ctx.silent = { files: true };
    expect(await checkFiles(h.ctx, { full: true })).toEqual([]);
    expect(rec(url).textHash).toBe(sha1(PDF_V1));
    h.ctx.silent = undefined;
  });

  it('never throws when the watch is deleted mid-check', async () => {
    addFile('/a.pdf');
    site.routes.set('/a.pdf', () => {
      h.store.deleteWatch(h.watch.id);
      return { status: 200, headers: { 'content-type': 'application/pdf' }, body: PDF_V1 };
    });
    expect(await sweep()).toEqual([]);
  });
});
