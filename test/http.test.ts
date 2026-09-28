import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import * as dnsPromises from 'node:dns/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HttpClient,
  assertAllowedUrl,
  decodeBody,
  describeNetworkError,
  detectChallenge,
  parseRetryAfter,
  type HttpClientOptions,
} from '../src/net/http.js';

// dns.lookup is only used by the SSRF guard; route fake ".test" names to fixed addresses, delegate the rest.
vi.mock('node:dns/promises', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:dns/promises')>();
  return { ...mod, lookup: vi.fn(mod.lookup) };
});

const FAKE_DNS: Record<string, string[]> = {
  'public.test': ['93.184.216.34'],
  'cache.public.test': ['93.184.216.35'],
  'private.test': ['10.0.0.5'],
  'mixed.test': ['93.184.216.34', '::1'],
  'mapped.test': ['::ffff:169.254.169.254'],
};

const lookupMock = vi.mocked(dnsPromises.lookup) as unknown as ReturnType<typeof vi.fn>;
const realLookup = lookupMock.getMockImplementation() as (host: string, opts: unknown) => Promise<unknown>;

beforeEach(() => {
  lookupMock.mockClear();
  lookupMock.mockImplementation(async (host: string, opts: unknown) => {
    const fake = FAKE_DNS[host];
    if (fake) return fake.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    if (host.endsWith('.nxdomain.test')) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return realLookup(host, opts);
  });
});

// ---------------------------------------------------------------------------
// Local test servers
// ---------------------------------------------------------------------------

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface TestServer {
  server: http.Server;
  url: (path?: string) => string;
  origin: string;
  hits: Map<string, number>;
  requests: http.IncomingMessage[];
  inFlight: number;
  maxInFlight: number;
}

const servers: TestServer[] = [];

async function startServer(handler: Handler): Promise<TestServer> {
  const state: TestServer = {
    server: null as unknown as http.Server,
    url: () => '',
    origin: '',
    hits: new Map(),
    requests: [],
    inFlight: 0,
    maxInFlight: 0,
  };
  state.server = http.createServer((req, res) => {
    const path = req.url ?? '/';
    state.hits.set(path, (state.hits.get(path) ?? 0) + 1);
    state.requests.push(req);
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    let counted = true;
    res.on('close', () => {
      if (counted) state.inFlight--;
      counted = false;
    });
    handler(req, res);
  });
  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  const { port } = state.server.address() as AddressInfo;
  state.origin = `http://127.0.0.1:${port}`;
  state.url = (path = '/') => `${state.origin}${path}`;
  servers.push(state);
  return state;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.server.closeAllConnections();
          s.server.close(() => resolve());
        }),
    ),
  );
});

afterAll(() => {
  vi.doUnmock('node:dns/promises');
});

function client(overrides: Partial<HttpClientOptions> = {}): HttpClient {
  return new HttpClient({
    userAgent: 'TestAgent/1.0',
    globalConcurrency: 16,
    perHostConcurrency: 8,
    timeoutMs: 5000,
    maxBytes: 5 * 1024 * 1024,
    allowPrivate: true,
    ...overrides,
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Basic responses & decoding
// ---------------------------------------------------------------------------

describe('HttpClient basics', () => {
  it('fetches a 200 HTML page with browser-like request headers', async () => {
    const srv = await startServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Custom', 'Yes');
      res.end('<html><title>Hi ✓</title></html>');
    });
    const res = await client().fetch(srv.url('/page'));
    expect(res).toMatchObject({
      url: srv.url('/page'),
      finalUrl: srv.url('/page'),
      status: 200,
      ok: true,
      notModified: false,
      redirected: false,
      contentType: 'text/html',
      bodyText: '<html><title>Hi ✓</title></html>',
      truncated: false,
      blocked: false,
      retryAfterMs: null,
      error: null,
    });
    expect(res.body?.toString('utf8')).toBe('<html><title>Hi ✓</title></html>');
    expect(res.headers['x-custom']).toBe('Yes');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0);

    const req = srv.requests[0];
    expect(req.method).toBe('GET');
    expect(req.headers['user-agent']).toBe('TestAgent/1.0');
    expect(req.headers.accept).toBe('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    expect(req.headers['accept-language']).toBe('en-US,en;q=0.9');
    expect(req.headers['if-none-match']).toBeUndefined();
  });

  it('decodes windows-1252 and iso-8859-1 bodies using the Content-Type charset', async () => {
    const latin = Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x20, 0x93, 0x71, 0x94]); // Café € “q”
    const srv = await startServer((req, res) => {
      res.setHeader('Content-Type', req.url === '/1252' ? 'text/html; charset=windows-1252' : 'text/plain; Charset="ISO-8859-1"');
      res.end(latin);
    });
    const http1252 = await client().fetch(srv.url('/1252'));
    expect(http1252.bodyText).toBe('Café € “q”');
    const latin1 = await client().fetch(srv.url('/latin1'));
    // WHATWG maps the iso-8859-1 label to windows-1252.
    expect(latin1.bodyText).toBe('Café € “q”');
    expect(latin1.contentType).toBe('text/plain');
  });

  it('falls back to utf-8 for unknown charsets and sniffs <meta charset> when the header has none', async () => {
    const srv = await startServer((req, res) => {
      if (req.url === '/bogus') {
        res.setHeader('Content-Type', 'text/html; charset=x-no-such-charset');
        res.end('naïve');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>'), Buffer.from([0xe9]), Buffer.from('</p>')]));
    });
    expect((await client().fetch(srv.url('/bogus'))).bodyText).toBe('naïve');
    expect((await client().fetch(srv.url('/meta'))).bodyText).toBe('<meta charset="windows-1252"><p>é</p>');
  });

  it('decodes textual types (json, js, xml, missing type) and leaves binary bodies undecoded', async () => {
    const srv = await startServer((req, res) => {
      const types: Record<string, string | null> = {
        '/json': 'application/json',
        '/js': 'application/javascript',
        '/xml': 'application/rss+xml; charset=utf-8',
        '/none': null,
        '/pdf': 'application/pdf',
        '/png': 'image/png',
      };
      const t = types[req.url ?? ''];
      if (t) res.setHeader('Content-Type', t);
      else res.removeHeader('Content-Type');
      res.end(req.url === '/pdf' ? Buffer.from('%PDF-1.7 binary') : `body of ${req.url}`);
    });
    const c = client();
    expect((await c.fetch(srv.url('/json'))).bodyText).toBe('body of /json');
    expect((await c.fetch(srv.url('/js'))).bodyText).toBe('body of /js');
    const xml = await c.fetch(srv.url('/xml'));
    expect(xml.bodyText).toBe('body of /xml');
    expect(xml.contentType).toBe('application/rss+xml');
    const none = await c.fetch(srv.url('/none'));
    expect(none.contentType).toBeNull();
    expect(none.bodyText).toBe('body of /none');
    const pdf = await c.fetch(srv.url('/pdf'));
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.bodyText).toBeNull();
    expect(pdf.body?.toString()).toBe('%PDF-1.7 binary');
    expect((await c.fetch(srv.url('/png'))).bodyText).toBeNull();
  });

  it('joins repeated headers with ", "', async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader('Set-Cookie', ['a=1', 'b=2']);
      res.setHeader('Vary', ['Accept', 'Accept-Encoding']);
      res.end('ok');
    });
    const res = await client().fetch(srv.url());
    expect(res.headers['set-cookie']).toBe('a=1, b=2');
    expect(res.headers.vary).toBe('Accept, Accept-Encoding');
    for (const k of Object.keys(res.headers)) expect(k).toBe(k.toLowerCase());
  });

  it('decompresses gzip exactly once and applies maxBytes to the decoded body', async () => {
    const text = 'hello gzip '.repeat(1000);
    const gz = zlib.gzipSync(text);
    const srv = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Encoding', 'gzip');
      res.end(gz);
    });
    const full = await client().fetch(srv.url());
    expect(full.bodyText).toBe(text);
    const capped = await client().fetch(srv.url(), { maxBytes: 100 });
    expect(capped.truncated).toBe(true);
    expect(capped.body?.length).toBe(100);
    expect(capped.bodyText).toBe(text.slice(0, 100));
  });

  it('sends extra headers and custom Accept', async () => {
    const srv = await startServer((_req, res) => res.end('ok'));
    await client().fetch(srv.url(), { accept: 'application/json', headers: { 'X-Api-Key': 'abc', 'User-Agent': 'Override/2' } });
    expect(srv.requests[0].headers.accept).toBe('application/json');
    expect(srv.requests[0].headers['x-api-key']).toBe('abc');
    expect(srv.requests[0].headers['user-agent']).toBe('Override/2');
  });

  it('returns an error result (no throw) for invalid URLs, protocols and headers', async () => {
    const c = client();
    const bad = await c.fetch('not a url');
    expect(bad).toMatchObject({ status: 0, ok: false, error: 'invalid URL', url: 'not a url', body: null });
    const ftp = await c.fetch('ftp://example.com/file');
    expect(ftp.status).toBe(0);
    expect(ftp.error).toBe('unsupported protocol ftp:');
    const srv = await startServer((_req, res) => res.end('ok'));
    const hdr = await c.fetch(srv.url(), { headers: { 'X-Bad': 'a\r\nInjected: 1' } });
    expect(hdr.status).toBe(0);
    expect(hdr.error).toMatch(/invalid request header/);
    const creds = await c.fetch(srv.url().replace('http://', 'http://user:pw@'));
    expect(creds.status).toBe(0);
    expect(creds.error).toBe('URLs with embedded credentials are not supported');
    expect(srv.hits.size).toBe(0);
  });

  it('falls back to sane limits for invalid per-request options', async () => {
    const srv = await startServer((_req, res) => res.end('x'.repeat(3000)));
    const c = client({ maxBytes: 1000 });
    const res = await c.fetch(srv.url(), { maxBytes: Number.NaN, timeoutMs: -1, retries: Number.NaN });
    expect(res.status).toBe(200);
    expect(res.body?.length).toBe(1000);
    expect(res.truncated).toBe(true);
    const unlimited = await c.fetch(srv.url(), { maxBytes: Infinity, timeoutMs: Number.MAX_SAFE_INTEGER });
    expect(unlimited.body?.length).toBe(3000);
    expect(unlimited.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Conditional requests, HEAD
// ---------------------------------------------------------------------------

describe('conditional requests and HEAD', () => {
  it('sends If-None-Match / If-Modified-Since and reports 304 as notModified with no body', async () => {
    const lm = 'Wed, 21 Oct 2015 07:28:00 GMT';
    const srv = await startServer((req, res) => {
      if (req.headers['if-none-match'] === '"v1"' || req.headers['if-modified-since'] === lm) {
        res.writeHead(304, { ETag: '"v1"' });
        res.end();
        return;
      }
      res.writeHead(200, { ETag: '"v1"', 'Last-Modified': lm, 'Content-Type': 'text/html' });
      res.end('<p>content</p>');
    });
    const c = client();
    const first = await c.fetch(srv.url());
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBe('"v1"');

    const byEtag = await c.fetch(srv.url(), { etag: first.headers.etag });
    expect(byEtag).toMatchObject({ status: 304, ok: false, notModified: true, body: null, bodyText: null, error: null });
    expect(srv.requests[1].headers['if-none-match']).toBe('"v1"');

    const byDate = await c.fetch(srv.url(), { lastModified: lm });
    expect(byDate.notModified).toBe(true);
    expect(srv.requests[2].headers['if-modified-since']).toBe(lm);
  });

  it('drops unusable stored validators instead of failing', async () => {
    const srv = await startServer((_req, res) => res.end('ok'));
    const res = await client().fetch(srv.url(), { etag: 'W/"x"\r\nevil: 1', lastModified: null });
    expect(res.status).toBe(200);
    expect(srv.requests[0].headers['if-none-match']).toBeUndefined();
    expect(srv.requests[0].headers.evil).toBeUndefined();
  });

  it('HEAD never reads a body', async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': '12345' });
      res.end(req.method === 'HEAD' ? undefined : Buffer.alloc(12345));
    });
    const res = await client().fetch(srv.url('/doc.pdf'), { method: 'HEAD' });
    expect(srv.requests[0].method).toBe('HEAD');
    expect(res).toMatchObject({ status: 200, ok: true, body: null, bodyText: null, contentType: 'application/pdf' });
    expect(res.headers['content-length']).toBe('12345');
  });
});

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

describe('redirects', () => {
  it('follows a redirect chain manually and reports finalUrl', async () => {
    const srv = await startServer((req, res) => {
      switch (req.url) {
        case '/a':
          res.writeHead(301, { Location: '/b' });
          return res.end('moved');
        case '/b':
          res.writeHead(302, { Location: `http://127.0.0.1:${(srv.server.address() as AddressInfo).port}/c?x=1` });
          return res.end();
        case '/c?x=1':
          res.writeHead(307, { Location: 'd' });
          return res.end();
        case '/d':
          res.writeHead(308, { Location: '/final' });
          return res.end();
        default:
          res.setHeader('Content-Type', 'text/html');
          return res.end('<p>final</p>');
      }
    });
    const res = await client().fetch(srv.url('/a'), { etag: '"e"' });
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);
    expect(res.url).toBe(srv.url('/a'));
    expect(res.finalUrl).toBe(srv.url('/final'));
    expect(res.bodyText).toBe('<p>final</p>');
    expect([...srv.hits.keys()]).toEqual(['/a', '/b', '/c?x=1', '/d', '/final']);
  });

  it('follows exactly 8 hops but fails on the 9th', async () => {
    const srv = await startServer((req, res) => {
      const n = Number((req.url ?? '').slice(1));
      if (n > 0) {
        res.writeHead(302, { Location: `/${n - 1}` });
        return res.end();
      }
      res.end('done');
    });
    const ok = await client().fetch(srv.url('/8'));
    expect(ok.status).toBe(200);
    expect(ok.finalUrl).toBe(srv.url('/0'));

    const tooMany = await client().fetch(srv.url('/9'));
    expect(tooMany.status).toBe(0);
    expect(tooMany.error).toMatch(/too many redirects/);
    expect(tooMany.redirected).toBe(true);
  });

  it('caps a redirect loop', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(302, { Location: '/loop' });
      res.end();
    });
    const res = await client().fetch(srv.url('/loop'));
    expect(res.status).toBe(0);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('too many redirects (>8)');
    expect(srv.hits.get('/loop')).toBe(9);
  });

  it('treats a 3xx without Location as the final response', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(302);
      res.end('no location');
    });
    const res = await client().fetch(srv.url());
    expect(res.status).toBe(302);
    expect(res.redirected).toBe(false);
    expect(res.bodyText).toBe('no location');
  });

  it('validates every hop (non-http redirect targets are refused)', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      res.end();
    });
    const res = await client().fetch(srv.url('/start'));
    expect(res.status).toBe(0);
    expect(res.error).toBe('unsupported protocol file:');
    expect(res.finalUrl).toBe('file:///etc/passwd');
    expect(res.redirected).toBe(true);
  });

  it('reports an unparsable Location', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(301, { Location: 'http://[::bad' });
      res.end();
    });
    const res = await client().fetch(srv.url());
    expect(res.status).toBe(0);
    expect(res.error).toBe('invalid redirect location');
  });

  it('decodes raw UTF-8 bytes in Location', async () => {
    const srv = await startServer((req, res) => {
      if (req.url === '/start') {
        const raw = Buffer.from('HTTP/1.1 302 Found\r\nLocation: /caf\xc3\xa9\r\nContent-Length: 0\r\n\r\n', 'latin1');
        req.socket.write(raw);
        return;
      }
      res.end(req.url);
    });
    const res = await client().fetch(srv.url('/start'));
    expect(res.status).toBe(200);
    expect(res.finalUrl).toBe(srv.url('/caf%C3%A9'));
  });

  it('remembers permanent same-origin redirects: the next request goes straight to the target', async () => {
    const srv = await startServer((req, res) => {
      if (req.url === '/a') {
        res.writeHead(301, { Location: '/a/' });
        return res.end();
      }
      if (req.url === '/temp') {
        res.writeHead(302, { Location: '/a/' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`at ${req.url}`);
    });
    const c = client();
    const first = await c.fetch(srv.url('/a'));
    const second = await c.fetch(srv.url('/a'));
    for (const r of [first, second]) {
      expect(r).toMatchObject({ status: 200, redirected: true, url: srv.url('/a'), finalUrl: srv.url('/a/'), bodyText: 'at /a/' });
    }
    expect(srv.hits.get('/a')).toBe(1);
    expect(srv.hits.get('/a/')).toBe(2);
    // Temporary redirects are always followed live.
    await c.fetch(srv.url('/temp'));
    await c.fetch(srv.url('/temp'));
    expect(srv.hits.get('/temp')).toBe(2);
  });

  it('keeps credentials on same-origin hops but strips them cross-origin', async () => {
    const other = await startServer((_req, res) => res.end('other'));
    const srv = await startServer((req, res) => {
      if (req.url === '/same') {
        res.writeHead(302, { Location: '/landing' });
        return res.end();
      }
      if (req.url === '/cross') {
        res.writeHead(302, { Location: other.url('/landing') });
        return res.end();
      }
      res.end('landed');
    });
    await client().fetch(srv.url('/same'), { headers: { Authorization: 'Bearer secret', 'X-Keep': '1' } });
    expect(srv.requests[1].headers.authorization).toBe('Bearer secret');

    const res = await client().fetch(srv.url('/cross'), { headers: { Authorization: 'Bearer secret', Cookie: 'sid=1', 'X-Keep': '1' } });
    expect(res.bodyText).toBe('other');
    expect(other.requests[0].headers.authorization).toBeUndefined();
    expect(other.requests[0].headers.cookie).toBeUndefined();
    expect(other.requests[0].headers['x-keep']).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// Body limits & timeouts
// ---------------------------------------------------------------------------

describe('body limits and timeouts', () => {
  it('truncates at maxBytes and releases the connection of an endless stream', async () => {
    let serverSawClose = false;
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const chunk = Buffer.alloc(16 * 1024, 'x');
      const timer = setInterval(() => res.write(chunk), 1);
      res.on('close', () => {
        serverSawClose = true;
        clearInterval(timer);
      });
    });
    const res = await client().fetch(srv.url(), { maxBytes: 50_000 });
    expect(res.status).toBe(200);
    expect(res.truncated).toBe(true);
    expect(res.body?.length).toBe(50_000);
    expect(res.bodyText).toBe('x'.repeat(50_000));
    for (let i = 0; i < 50 && !serverSawClose; i++) await delay(20);
    expect(serverSawClose).toBe(true);
  });

  it('uses the client-level maxBytes by default and is not truncated at exactly the limit', async () => {
    const srv = await startServer((req, res) => res.end(Buffer.alloc(req.url === '/exact' ? 2048 : 2049, 'a')));
    const c = client({ maxBytes: 2048 });
    const exact = await c.fetch(srv.url('/exact'));
    expect(exact.truncated).toBe(false);
    expect(exact.body?.length).toBe(2048);
    const over = await c.fetch(srv.url('/over'));
    expect(over.truncated).toBe(true);
    expect(over.body?.length).toBe(2048);
  });

  it('times out when no response arrives → status 0 "timeout after Ns"', async () => {
    const srv = await startServer(() => {
      /* never respond */
    });
    const started = Date.now();
    const res = await client().fetch(srv.url('/hang'), { timeoutMs: 300 });
    expect(res.status).toBe(0);
    expect(res.error).toBe('timeout after 0.3s');
    expect(res.body).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(srv.hits.get('/hang')).toBe(1); // timeouts are not retried
  });

  it('uses the client-level timeout and formats whole seconds', async () => {
    const srv = await startServer(() => {});
    const res = await client({ timeoutMs: 1000 }).fetch(srv.url());
    expect(res.error).toBe('timeout after 1s');
  });

  it('times out while the body is still streaming', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.write('<p>partial');
      // ...and never finish
    });
    const started = Date.now();
    const res = await client().fetch(srv.url(), { timeoutMs: 400 });
    expect(res.status).toBe(0);
    expect(res.error).toBe('timeout after 0.4s');
    expect(res.bodyText).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports a connection dropped mid-body as a network error, never a partial body', async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '1000' });
      res.write('<p>only part');
      setTimeout(() => req.socket.destroy(), 20);
    });
    const res = await client().fetch(srv.url('/drop'), { retries: 0 });
    expect(res.status).toBe(0);
    expect(res.body).toBeNull();
    expect(res.error).toBeTruthy();
    expect(res.error).not.toMatch(/timeout/);
  });

  it('reports connection refused', async () => {
    const tmp = http.createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    const { port } = tmp.address() as AddressInfo;
    await new Promise<void>((r) => tmp.close(() => r()));
    const res = await client().fetch(`http://127.0.0.1:${port}/`, { retries: 0 });
    expect(res.status).toBe(0);
    expect(res.error).toBe('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// Retries & rate limits
// ---------------------------------------------------------------------------

describe('retries', () => {
  it('retries a 503 and returns the later success', async () => {
    let n = 0;
    const srv = await startServer((_req, res) => {
      n++;
      if (n === 1) {
        res.writeHead(503, { 'Content-Type': 'text/html' });
        return res.end('<h1>Service Unavailable</h1>');
      }
      res.end('recovered');
    });
    const started = Date.now();
    const res = await client().fetch(srv.url());
    expect(res.status).toBe(200);
    expect(res.bodyText).toBe('recovered');
    expect(n).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(res.elapsedMs).toBeGreaterThanOrEqual(450);
  });

  it('gives up after `retries` extra attempts with exponential backoff', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(502);
      res.end('bad gateway');
    });
    const started = Date.now();
    const res = await client().fetch(srv.url(), { retries: 2 });
    expect(res.status).toBe(502);
    expect(srv.hits.get('/')).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400); // 500 + 1000
  });

  it('does not retry with retries: 0', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(504);
      res.end();
    });
    const res = await client().fetch(srv.url(), { retries: 0 });
    expect(res.status).toBe(504);
    expect(srv.hits.get('/')).toBe(1);
  });

  it('retries network errors', async () => {
    let n = 0;
    const srv = await startServer((req, res) => {
      n++;
      if (n === 1) {
        req.socket.destroy();
        return;
      }
      res.end('second time lucky');
    });
    const res = await client().fetch(srv.url());
    expect(res.status).toBe(200);
    expect(res.bodyText).toBe('second time lucky');
    expect(n).toBe(2);
  });

  it('does not retry 429 and parses Retry-After seconds', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(429, { 'Retry-After': '120' });
      res.end('slow down');
    });
    const res = await client().fetch(srv.url());
    expect(res.status).toBe(429);
    expect(res.retryAfterMs).toBe(120_000);
    expect(res.blocked).toBe(false);
    expect(srv.hits.get('/')).toBe(1);
  });

  it('backs off from a host that answered 429: no requests until Retry-After, except ignoreBackoff ones', async () => {
    let status = 429;
    const srv = await startServer((_req, res) => {
      res.writeHead(status, status === 429 ? { 'Retry-After': '60' } : { 'Content-Type': 'text/plain' });
      res.end(status === 429 ? 'slow down' : 'ok');
    });
    const clock = { now: 1_000_000 };
    const c = client({ now: () => clock.now });
    expect((await c.fetch(srv.url('/a'))).status).toBe(429);
    expect(srv.hits.get('/a')).toBe(1);

    const held = await c.fetch(srv.url('/b'));
    expect(held).toMatchObject({ status: 429, ok: false, error: 'rate limited (backing off)' });
    expect(held.retryAfterMs).toBe(60_000);
    expect(srv.hits.get('/b')).toBeUndefined();
    expect(c.backoffUntil('127.0.0.1')).toBe(1_060_000);

    // The homepage check still goes out (to notice recovery); a 2xx ends the backoff.
    status = 200;
    expect((await c.fetch(srv.url('/'), { ignoreBackoff: true })).status).toBe(200);
    expect(c.backoffUntil('127.0.0.1')).toBeNull();
    expect((await c.fetch(srv.url('/b'))).status).toBe(200);

    // Without a 2xx in between, the backoff simply expires.
    status = 429;
    await c.fetch(srv.url('/c'));
    expect((await c.fetch(srv.url('/d'))).error).toBe('rate limited (backing off)');
    clock.now += 61_000;
    status = 200;
    expect((await c.fetch(srv.url('/d'))).status).toBe(200);
  });

  it('parses an HTTP-date Retry-After', async () => {
    const at = new Date(Date.now() + 60_000).toUTCString();
    const srv = await startServer((_req, res) => {
      res.writeHead(429, { 'Retry-After': at });
      res.end();
    });
    const res = await client().fetch(srv.url());
    expect(res.retryAfterMs).toBeGreaterThan(55_000);
    expect(res.retryAfterMs).toBeLessThanOrEqual(60_000);
  });
});

// ---------------------------------------------------------------------------
// Bot challenges
// ---------------------------------------------------------------------------

describe('bot-challenge detection', () => {
  it('flags a Cloudflare "Just a moment..." 403', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=UTF-8', Server: 'cloudflare' });
      res.end('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>');
    });
    const res = await client().fetch(srv.url());
    expect(res.status).toBe(403);
    expect(res.blocked).toBe(true);
  });

  it('flags cf-mitigated: challenge regardless of body', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(403, { 'cf-mitigated': 'challenge' });
      res.end();
    });
    expect((await client().fetch(srv.url())).blocked).toBe(true);
    expect((await client().fetch(srv.url(), { method: 'HEAD' })).blocked).toBe(true);
  });

  it('does not retry a challenged 503', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/html' });
      res.end('<title>Attention Required! | Cloudflare</title> DDoS protection by Cloudflare');
    });
    const res = await client().fetch(srv.url());
    expect(res.blocked).toBe(true);
    expect(srv.hits.get('/')).toBe(1);
  });

  it('does not flag an origin 503 maintenance page that only carries Cloudflare\'s JS-detections script', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/html', Server: 'cloudflare' });
      res.end(
        '<html><body><h1>Down for maintenance</h1>' +
          '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>' +
          '<script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/e0c90b6a3ed1/main.js?"></script></body></html>',
      );
    });
    const res = await client().fetch(srv.url(), { retries: 0 });
    expect(res.status).toBe(503);
    expect(res.blocked).toBe(false);
  });

  it('does not flag ordinary error pages or 200 pages mentioning the markers', async () => {
    const srv = await startServer((req, res) => {
      if (req.url === '/403') {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        return res.end('<h1>Forbidden</h1>');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<p>Our blog post about "Just a moment..." pages</p>');
    });
    expect((await client().fetch(srv.url('/403'))).blocked).toBe(false);
    expect((await client().fetch(srv.url('/blog'))).blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

describe('private-address blocking', () => {
  it('blocks loopback literals when allowPrivate=false without contacting them', async () => {
    const srv = await startServer((_req, res) => res.end('secret'));
    const res = await client({ allowPrivate: false }).fetch(srv.url('/admin'));
    expect(res.status).toBe(0);
    expect(res.error).toBe('blocked private address 127.0.0.1');
    expect(res.body).toBeNull();
    expect(srv.hits.size).toBe(0);
  });

  it('blocks internal hostnames by name', async () => {
    const c = client({ allowPrivate: false });
    for (const url of ['http://localhost:1234/', 'http://api.railway.internal/', 'http://printer.local/', 'http://intranet/']) {
      const res = await c.fetch(url);
      expect(res.status).toBe(0);
      expect(res.error).toMatch(/^blocked private address /);
    }
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blocks hostnames that resolve to any private address', async () => {
    const c = client({ allowPrivate: false });
    expect((await c.fetch('http://private.test/')).error).toBe('blocked private address 10.0.0.5');
    expect((await c.fetch('https://mixed.test/')).error).toBe('blocked private address ::1');
    expect((await c.fetch('https://mapped.test/')).error).toBe('blocked private address ::ffff:169.254.169.254');
  });

  it('blocks a redirect hop to a private address', async () => {
    const fetchSpy = vi.fn(async (input: string) => {
      const u = String(input);
      if (u === 'https://public.test/') return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } });
      return new Response('should not be fetched');
    });
    const res = await client({ allowPrivate: false, fetch: fetchSpy }).fetch('https://public.test/');
    expect(res.status).toBe(0);
    expect(res.error).toBe('blocked private address 169.254.169.254');
    expect(res.redirected).toBe(true);
    expect(res.finalUrl).toBe('http://169.254.169.254/latest/meta-data/');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('allows public hosts and caches the DNS verdict briefly', async () => {
    const fetchSpy = vi.fn(async (_url: string, init: Record<string, unknown>) => {
      // Requests that must not reach private addresses go through the connect-time checking agent.
      expect(init.dispatcher).toBeDefined();
      return new Response('public ok', { headers: { 'Content-Type': 'text/plain' } });
    });
    const c = client({ allowPrivate: false, fetch: fetchSpy });
    const first = await c.fetch('https://cache.public.test/a');
    const second = await c.fetch('https://cache.public.test/b');
    expect(first.bodyText).toBe('public ok');
    expect(second.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(lookupMock.mock.calls.filter((call) => call[0] === 'cache.public.test')).toHaveLength(1);
  });

  it('reports DNS failures of the guard as the error code', async () => {
    const res = await client({ allowPrivate: false }).fetch('https://nope.nxdomain.test/', { retries: 0 });
    expect(res.status).toBe(0);
    expect(res.error).toBe('ENOTFOUND');
  });

  it('re-checks addresses at connect time: DNS rebinding to a private address is blocked', async () => {
    const srv = await startServer((_req, res) => res.end('SECRET internal admin page'));
    const port = new URL(srv.origin).port;
    let lookups = 0;
    const rebinding = async () => (lookups++ === 0 ? [{ address: '93.184.215.14', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    const res = await client({ allowPrivate: false, lookup: rebinding }).fetch(`http://rebind.test:${port}/admin`, { retries: 0 });
    expect(res.status).toBe(0);
    expect(res.error).toBe('blocked private address 127.0.0.1');
    expect(lookups).toBe(2);
    expect(srv.hits.size).toBe(0);

    // A cached public verdict does not help either: the connection itself is checked.
    let n = 0;
    const flipping = async () => (n++ < 1 ? [{ address: '93.184.215.14', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    const c = client({ allowPrivate: false, lookup: flipping });
    await c.fetch(`http://rebind2.test:${port}/`, { retries: 0 });
    const again = await c.fetch(`http://rebind2.test:${port}/admin`, { retries: 0 });
    expect(again.status).toBe(0);
    expect(again.error).toBe('blocked private address 127.0.0.1');
    expect(srv.hits.size).toBe(0);
  });

  it('per-request allowPrivate overrides the client setting', async () => {
    const srv = await startServer((_req, res) => res.end('ok'));
    const res = await client({ allowPrivate: false }).fetch(srv.url(), { allowPrivate: true });
    expect(res.status).toBe(200);
    const blocked = await client({ allowPrivate: true }).fetch(srv.url(), { allowPrivate: false });
    expect(blocked.status).toBe(0);
  });
});

describe('assertAllowedUrl', () => {
  it('rejects non-http(s) and malformed URLs even when private is allowed', async () => {
    await expect(assertAllowedUrl('ftp://example.com/', true)).rejects.toThrow('unsupported protocol ftp:');
    await expect(assertAllowedUrl('javascript:alert(1)', true)).rejects.toThrow('unsupported protocol');
    await expect(assertAllowedUrl('::nope::', true)).rejects.toThrow('invalid URL');
    await expect(assertAllowedUrl('http://127.0.0.1/', true)).resolves.toBeUndefined();
  });

  it('rejects private literals in every spelling', async () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://10.1.2.3:8080/x',
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[fd00::1]/',
      'http://0x7f.1/',
      'http://2130706433/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.100.100.200/',
      'http://localhost/',
      'http://foo.localhost/',
      'http://db.railway.internal:5432/',
    ]) {
      await expect(assertAllowedUrl(url, false), url).rejects.toThrow(/^blocked private address /);
    }
  });

  it('accepts public literals and publicly resolving names', async () => {
    await expect(assertAllowedUrl('https://1.1.1.1/', false)).resolves.toBeUndefined();
    await expect(assertAllowedUrl('https://[2606:4700:4700::1111]/', false)).resolves.toBeUndefined();
    await expect(assertAllowedUrl('https://public.test/path', false)).resolves.toBeUndefined();
    await expect(assertAllowedUrl('https://private.test/path', false)).rejects.toThrow('blocked private address 10.0.0.5');
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('concurrency limits', () => {
  it('respects the per-host limit (observed on the server)', async () => {
    const srv = await startServer((_req, res) => {
      setTimeout(() => res.end('ok'), 40);
    });
    const c = client({ perHostConcurrency: 2, globalConcurrency: 10 });
    const all = Promise.all(Array.from({ length: 8 }, (_, i) => c.fetch(srv.url(`/${i}`))));
    await delay(15);
    const mid = c.stats();
    expect(mid.active).toBe(2);
    expect(mid.pending).toBe(6);
    const results = await all;
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(srv.maxInFlight).toBe(2);
    expect(c.stats()).toEqual({ active: 0, pending: 0 });
  });

  it('respects the global limit', async () => {
    const srv = await startServer((_req, res) => {
      setTimeout(() => res.end('ok'), 40);
    });
    const c = client({ perHostConcurrency: 10, globalConcurrency: 3 });
    const results = await Promise.all(Array.from({ length: 9 }, (_, i) => c.fetch(srv.url(`/${i}`))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(srv.maxInFlight).toBe(3);
  });

  it('frees the slot while backing off between retries', async () => {
    let failFirst = true;
    const srv = await startServer((req, res) => {
      if (req.url === '/flaky' && failFirst) {
        failFirst = false;
        res.writeHead(503);
        return res.end();
      }
      res.end('ok');
    });
    const c = client({ perHostConcurrency: 1, globalConcurrency: 1 });
    const flaky = c.fetch(srv.url('/flaky'));
    await delay(100); // first attempt done, now sleeping ~500ms
    const started = Date.now();
    const other = await c.fetch(srv.url('/other'));
    expect(other.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(300);
    expect((await flaky).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('helpers', () => {
  it('parseRetryAfter', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter(' 30 ', now)).toBe(30_000);
    expect(parseRetryAfter('1.5', now)).toBe(1500);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', now)).toBe(60_000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('999999999', now)).toBe(24 * 3600_000);
    expect(parseRetryAfter('-5', now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter('', now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it('describeNetworkError', () => {
    const wrap = (cause: unknown) => Object.assign(new TypeError('fetch failed'), { cause });
    expect(describeNetworkError(wrap(Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' })))).toBe('ECONNREFUSED');
    expect(describeNetworkError(wrap(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' })))).toBe('ENOTFOUND');
    expect(describeNetworkError(wrap(Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })))).toBe('connect timeout');
    expect(describeNetworkError(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }))).toBe(
      'socket error: other side closed',
    );
    expect(describeNetworkError(wrap(Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' })))).toBe('CERT_HAS_EXPIRED');
    expect(describeNetworkError(wrap(new Error('bad port')))).toBe('bad port');
    const agg = new AggregateError([Object.assign(new Error('x'), { code: 'EHOSTUNREACH' })], 'all failed');
    expect(describeNetworkError(wrap(agg))).toBe('EHOSTUNREACH');
    expect(describeNetworkError(new TypeError('fetch failed'))).toBe('network error');
    expect(describeNetworkError(null)).toBe('network error');
    expect(describeNetworkError('weird')).toBe('weird');
    const loop: { message: string; cause?: unknown } = { message: 'loop' };
    loop.cause = loop;
    expect(describeNetworkError(loop)).toBe('loop');
    expect(describeNetworkError(new Error('x'.repeat(1000))).length).toBeLessThanOrEqual(200);
  });

  it('detectChallenge', () => {
    expect(detectChallenge(200, { 'cf-mitigated': 'challenge' }, null)).toBe(true);
    expect(detectChallenge(429, { 'x-vercel-mitigated': 'challenge' }, '')).toBe(true);
    expect(detectChallenge(202, { 'x-amzn-waf-action': 'captcha' }, '')).toBe(true);
    const markers = [
      'Just a moment...',
      'cf-browser-verification',
      'challenge-platform',
      'Attention Required! | Cloudflare',
      'DDoS protection by',
      'Checking your browser',
      'px-captcha',
      '_Incapsula_Resource',
      'captcha-delivery.com',
    ];
    for (const marker of markers) {
      expect(detectChallenge(403, {}, `<html>${marker}</html>`)).toBe(true);
      expect(detectChallenge(429, {}, marker)).toBe(true);
      expect(detectChallenge(503, {}, marker)).toBe(true);
      expect(detectChallenge(200, {}, marker)).toBe(false);
      expect(detectChallenge(404, {}, marker)).toBe(false);
    }
    expect(detectChallenge(403, {}, null)).toBe(false);
  });

  it('decodeBody honours BOMs, header charset, meta/xml declarations', () => {
    expect(decodeBody(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]), 'text/html')).toBe('hi');
    expect(decodeBody(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]), 'text/html; charset=windows-1252')).toBe('hi');
    expect(decodeBody(Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]), undefined)).toBe('hi');
    expect(decodeBody(Buffer.from([0xe9]), 'text/plain; charset="latin1"')).toBe('é');
    expect(decodeBody(Buffer.from([0x80, 0x81, 0x85, 0x9f, 0xe9, 0x41]), 'text/plain; charset=cp1252')).toBe('€\u0081…Ÿé' + 'A');
    expect(decodeBody(Buffer.from([0x93, 0x94]), 'text/plain; charset=us-ascii')).toBe('“”');
    expect(decodeBody(Buffer.from([0xc0, 0xe9]), 'text/plain; charset=windows-1251')).toBe('Ай');
    expect(decodeBody(Buffer.concat([Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><a>'), Buffer.from([0xe9])]), 'application/xml')).toBe(
      '<?xml version="1.0" encoding="ISO-8859-1"?><a>é',
    );
    expect(decodeBody(Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=utf-16">ok'), 'text/html')).toBe(
      '<meta http-equiv="Content-Type" content="text/html; charset=utf-16">ok',
    );
    // In-document declarations are ignored for non-HTML/XML types.
    expect(decodeBody(Buffer.concat([Buffer.from('<meta charset="windows-1252">'), Buffer.from([0xc3, 0xa9])]), 'text/plain')).toBe('<meta charset="windows-1252">é');
    // Invalid bytes never throw.
    expect(decodeBody(Buffer.from([0xff, 0x41]), 'text/html; charset=utf-8')).toBe('�A');
  });
});
