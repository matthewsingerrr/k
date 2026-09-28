import dgram from 'node:dgram';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDnsProvider, isInternalHostname, isPrivateAddress, matchesWildcard } from '../src/net/dns.js';
import type { DnsInfo } from '../src/types.js';

// ---------------------------------------------------------------------------
// Tiny authoritative DNS stub (UDP) so resolve()/wildcard() never touch the internet.
// ---------------------------------------------------------------------------

type Behaviour = 'nxdomain' | 'servfail' | 'silent';
interface ZoneEntry {
  A?: string[];
  AAAA?: string[];
  CNAME?: string;
  /** Applies to every query type for the name. */
  behaviour?: Behaviour;
  /** Never answer AAAA queries (a real-world broken-server pattern). */
  silentAAAA?: boolean;
}

const QTYPE = { A: 1, CNAME: 5, AAAA: 28 } as const;

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean);
  const bufs = parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, 'ascii')]));
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function ipv6Bytes(ip: string): Buffer {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...new Array(8 - h.length - t.length).fill('0'), ...t] : h;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(Number.parseInt(g, 16), i * 2));
  return out;
}

function record(owner: Buffer, type: number, rdata: Buffer): Buffer {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(1, 2); // IN
  fixed.writeUInt32BE(60, 4);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([owner, fixed, rdata]);
}

class DnsStub {
  readonly zone = new Map<string, ZoneEntry>();
  readonly queries: Array<{ name: string; type: number }> = [];
  private socket = dgram.createSocket('udp4');
  port = 0;

  async start(): Promise<void> {
    this.socket.on('message', (msg, rinfo) => {
      const reply = this.answer(msg);
      if (reply) this.socket.send(reply, rinfo.port, rinfo.address);
    });
    await new Promise<void>((resolve) => this.socket.bind(0, '127.0.0.1', resolve));
    this.port = this.socket.address().port;
  }

  /** Queries so far, ignoring late c-ares retries for the deliberately unanswered names. */
  count(): number {
    return this.queries.filter((q) => q.name !== 'silent.test' && q.name !== 'noaaaa.test').length;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.socket.close(() => resolve()));
  }

  private lookup(name: string): ZoneEntry | undefined {
    const exact = this.zone.get(name);
    if (exact) return exact;
    const labels = name.split('.');
    for (let i = 1; i < labels.length; i++) {
      const wc = this.zone.get(`*.${labels.slice(i).join('.')}`);
      if (wc) return wc;
    }
    return undefined;
  }

  private answer(msg: Buffer): Buffer | null {
    if (msg.length < 12) return null;
    let off = 12;
    const labels: string[] = [];
    while (off < msg.length && msg[off] !== 0) {
      const len = msg[off];
      labels.push(msg.subarray(off + 1, off + 1 + len).toString('ascii'));
      off += len + 1;
    }
    off += 1;
    const qtype = msg.readUInt16BE(off);
    off += 4;
    const question = msg.subarray(12, off);
    const name = labels.join('.').toLowerCase();
    this.queries.push({ name, type: qtype });

    const entry = this.lookup(name);
    if (entry?.behaviour === 'silent') return null;
    if (entry?.silentAAAA && qtype === QTYPE.AAAA) return null;
    let rcode = 0;
    const answers: Buffer[] = [];
    if (!entry || entry.behaviour === 'nxdomain') rcode = 3;
    else if (entry.behaviour === 'servfail') rcode = 2;
    else {
      const qname = Buffer.from([0xc0, 0x0c]);
      let owner: Buffer = qname;
      let target = entry;
      if (entry.CNAME) {
        answers.push(record(qname, QTYPE.CNAME, encodeName(entry.CNAME)));
        owner = encodeName(entry.CNAME);
        target = this.zone.get(entry.CNAME.toLowerCase().replace(/\.$/, '')) ?? {};
      }
      if (qtype === QTYPE.A) for (const ip of target.A ?? []) answers.push(record(owner, QTYPE.A, Buffer.from(ip.split('.').map(Number))));
      if (qtype === QTYPE.AAAA) for (const ip of target.AAAA ?? []) answers.push(record(owner, QTYPE.AAAA, ipv6Bytes(ip)));
    }
    const header = Buffer.alloc(12);
    header.writeUInt16BE(msg.readUInt16BE(0), 0);
    header.writeUInt16BE(0x8180 | rcode, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answers.length, 6);
    return Buffer.concat([header, question, ...answers]);
  }
}

const stub = new DnsStub();

beforeAll(async () => {
  await stub.start();
  stub.zone.set('a-only.test', { A: ['93.184.216.34'] });
  stub.zone.set('dual.test', { A: ['203.0.113.9', '198.51.100.1', '203.0.113.9'], AAAA: ['2001:DB8::1', '2001:db8::1'] });
  stub.zone.set('alias.test', { CNAME: 'Target.Example.NET.' });
  stub.zone.set('target.example.net', { A: ['192.0.2.10'] });
  stub.zone.set('nodata.test', {});
  stub.zone.set('servfail.test', { behaviour: 'servfail' });
  stub.zone.set('silent.test', { behaviour: 'silent' });
  stub.zone.set('noaaaa.test', { A: ['192.0.2.55'], silentAAAA: true });
  stub.zone.set('*.wild.test', { A: ['192.0.2.77'] });
  stub.zone.set('*.cnamewild.test', { CNAME: 'lb.example.net' });
  stub.zone.set('lb.example.net', { A: ['192.0.2.88'] });
  stub.zone.set('flaky.test', { behaviour: 'servfail' });
  stub.zone.set('*.flaky.test', { behaviour: 'servfail' });
  stub.zone.set('plain.test', { A: ['192.0.2.1'] });
});

afterAll(async () => {
  await stub.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function provider(timeoutMs = 1500) {
  return createDnsProvider({ servers: [`127.0.0.1:${stub.port}`], timeoutMs });
}

describe('createDnsProvider().resolve', () => {
  it('resolves A records', async () => {
    expect(await provider().resolve('a-only.test')).toEqual({ a: ['93.184.216.34'], aaaa: [], cname: [] });
  });

  it('sorts and de-duplicates A and AAAA answers', async () => {
    expect(await provider().resolve('dual.test')).toEqual({
      a: ['198.51.100.1', '203.0.113.9'],
      aaaa: ['2001:db8::1'],
      cname: [],
    });
  });

  it('returns CNAME targets lowercased without the trailing dot (plus the chased addresses)', async () => {
    expect(await provider().resolve('alias.test')).toEqual({ a: ['192.0.2.10'], aaaa: [], cname: ['target.example.net'] });
  });

  it('normalizes the queried name (case, trailing dot)', async () => {
    expect(await provider().resolve('  A-ONLY.Test.  ')).toEqual({ a: ['93.184.216.34'], aaaa: [], cname: [] });
  });

  it('returns null for NXDOMAIN, NODATA and SERVFAIL', async () => {
    const dns = provider();
    expect(await dns.resolve('missing.test')).toBeNull();
    expect(await dns.resolve('nodata.test')).toBeNull();
    expect(await dns.resolve('servfail.test')).toBeNull();
  });

  it('returns null when the server never answers, within the overall timeout', async () => {
    const started = Date.now();
    expect(await provider(400).resolve('silent.test')).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('keeps the answers that arrived when another query type times out', async () => {
    const started = Date.now();
    expect(await provider(400).resolve('noaaaa.test')).toEqual({ a: ['192.0.2.55'], aaaa: [], cname: [] });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('rejects invalid names without querying', async () => {
    const before = stub.count();
    const dns = provider();
    for (const bad of ['', '   ', 'has space.test', 'a..b.test', '-', `${'x'.repeat(64)}.test`, `${'abc.'.repeat(70)}test`, 'ev!l.test', '*.wild.test']) {
      expect(await dns.resolve(bad)).toBeNull();
    }
    expect(await dns.resolve(undefined as unknown as string)).toBeNull();
    expect(stub.count()).toBe(before);
  });

  it('answers IP literals without querying', async () => {
    const before = stub.count();
    expect(await provider().resolve('192.0.2.5')).toEqual({ a: ['192.0.2.5'], aaaa: [], cname: [] });
    expect(await provider().resolve('2001:db8::5')).toEqual({ a: [], aaaa: ['2001:db8::5'], cname: [] });
    expect(stub.count()).toBe(before);
  });

  it('throws a clear error for invalid server addresses', () => {
    expect(() => createDnsProvider({ servers: ['not an ip'] })).toThrow(/invalid DNS servers/);
  });

  it('accepts an empty server list (system resolver) and still validates names locally', async () => {
    const dns = createDnsProvider({ servers: [] });
    expect(await dns.resolve('bad name')).toBeNull();
  });
});

describe('createDnsProvider().wildcard', () => {
  it('detects a wildcard zone and returns the union of answers', async () => {
    const wc = await provider().wildcard('wild.test');
    expect(wc).toEqual(new Set(['A:192.0.2.77']));
    const probes = stub.queries.map((q) => q.name).filter((n) => n.endsWith('.wild.test')).slice(-12);
    const labels = new Set(probes);
    expect(labels.size).toBe(4);
    for (const l of labels) expect(l).toMatch(/^wc-[0-9a-f]{16}\.wild\.test$/);
  });

  it('includes CNAME answers', async () => {
    const wc = await provider().wildcard('cnamewild.test');
    expect(wc).toEqual(new Set(['A:192.0.2.88', 'CNAME:lb.example.net']));
  });

  it('returns null for a zone without a wildcard', async () => {
    expect(await provider().wildcard('plain.test')).toBeNull();
  });

  it('caches results per domain for 10 minutes and shares in-flight probes', async () => {
    const dns = provider();
    const before = stub.count();
    const [a, b] = await Promise.all([dns.wildcard('wild.test'), dns.wildcard('WILD.test.')]);
    const afterFirst = stub.count();
    expect(afterFirst - before).toBe(12); // 4 labels × (A, AAAA, CNAME)
    expect(a).toEqual(b);
    expect(await dns.wildcard('wild.test')).toEqual(a);
    expect(await dns.wildcard('plain.test')).toBeNull();
    const afterPlain = stub.count();
    expect(await dns.wildcard('plain.test')).toBeNull();
    expect(stub.count()).toBe(afterPlain);

    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 9 * 60_000);
    await dns.wildcard('wild.test');
    expect(stub.count()).toBe(afterPlain);
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 11 * 60_000);
    await dns.wildcard('wild.test');
    expect(stub.count()).toBe(afterPlain + 12);
  });

  it('hands out copies so callers cannot corrupt the cache', async () => {
    const dns = provider();
    const first = await dns.wildcard('wild.test');
    first!.add('A:6.6.6.6');
    first!.clear();
    expect(await dns.wildcard('wild.test')).toEqual(new Set(['A:192.0.2.77']));
  });

  it('retries inconclusive (SERVFAIL/timeout) probes after a minute instead of caching for 10', async () => {
    const dns = provider();
    const before = stub.count();
    expect(await dns.wildcard('flaky.test')).toBeNull();
    const afterFirst = stub.count();
    expect(afterFirst).toBeGreaterThan(before);
    expect(await dns.wildcard('flaky.test')).toBeNull();
    expect(stub.count()).toBe(afterFirst);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60_000);
    expect(await dns.wildcard('flaky.test')).toBeNull();
    expect(stub.count()).toBeGreaterThan(afterFirst);
  });

  it('returns null for invalid domains and IPs', async () => {
    const dns = provider();
    expect(await dns.wildcard('')).toBeNull();
    expect(await dns.wildcard('bad domain')).toBeNull();
    expect(await dns.wildcard('10.0.0.1')).toBeNull();
  });
});

describe('isPrivateAddress', () => {
  const privateIps = [
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '127.255.0.9',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fe80::1%eth0',
    'febf::1',
    'fec0::1',
    'ff02::1',
    'FF05::2',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '::FFFF:192.168.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:a9fe:a9fe',
    '::ffff:0:10.1.2.3',
    '::127.0.0.1',
    '64:ff9b::10.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '2002:c0a8:0101::1',
    '2002:7f00:1::',
    '[::1]',
    '[fe80::abcd]',
    ' 10.0.0.1 ',
  ];
  const publicIps = [
    '1.1.1.1',
    '8.8.8.8',
    '9.255.255.255',
    '11.0.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '126.255.255.255',
    '128.0.0.1',
    '169.253.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '192.0.1.1',
    '192.169.0.1',
    '198.17.255.255',
    '198.20.0.1',
    '223.255.255.255',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2a00:1450:4001:80b::200e',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '64:ff9b::8.8.8.8',
    '2002:0808:0808::1',
    'fbff::1',
    'fe7f::1',
  ];
  const notIps = ['', 'localhost', 'example.com', '10.0.0', '10.0.0.1.5', '256.1.1.1', '01.2.3.4', '::g', '1:2:3:4:5:6:7:8:9', ':::1', 'fe80::1::2', '[10.0.0.1'];

  it.each(privateIps)('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(publicIps)('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it.each(notIps)('%j is not an IP → false', (s) => {
    expect(isPrivateAddress(s)).toBe(false);
  });

  it('never throws on garbage input', () => {
    for (const v of [null, undefined, 42, {}, [], '\u0000', 'x'.repeat(10_000)]) {
      expect(() => isPrivateAddress(v as unknown as string)).not.toThrow();
      expect(isPrivateAddress(v as unknown as string)).toBe(false);
    }
  });
});

describe('isInternalHostname', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'localhost.',
    'app.localhost',
    'printer.local',
    'db.internal',
    'api.railway.internal',
    'metadata.google.internal',
    'intranet',
    'router',
    '',
    '  ',
  ])('%j is internal', (h) => {
    expect(isInternalHostname(h)).toBe(true);
  });

  it.each(['example.com', 'unpeg.io', 'docs.unpeg.io', 'localhost.example.com', 'local.example.com', 'internal.example.com', 'my-local.dev', 'a.b.c.d.e'])(
    '%j is not internal',
    (h) => {
      expect(isInternalHostname(h)).toBe(false);
    },
  );

  it('leaves IP literals to isPrivateAddress', () => {
    for (const ip of ['127.0.0.1', '8.8.8.8', '::1', '[::1]', '2606:4700::1111', 'fe80::1%eth0']) {
      expect(isInternalHostname(ip)).toBe(false);
    }
  });
});

describe('matchesWildcard', () => {
  const wc = new Set(['A:192.0.2.77', 'A:192.0.2.78', 'AAAA:2001:db8::77', 'CNAME:lb.example.net']);
  const info = (a: string[] = [], aaaa: string[] = [], cname: string[] = []): DnsInfo => ({ a, aaaa, cname });

  it('is false without a wildcard', () => {
    expect(matchesWildcard(info(['192.0.2.77']), null)).toBe(false);
    expect(matchesWildcard(info(['192.0.2.77']), new Set())).toBe(false);
  });

  it('is true when every answer is in the wildcard set', () => {
    expect(matchesWildcard(info(['192.0.2.77']), wc)).toBe(true);
    expect(matchesWildcard(info(['192.0.2.78', '192.0.2.77'], ['2001:DB8::77']), wc)).toBe(true);
    expect(matchesWildcard(info([], [], ['LB.example.net.']), wc)).toBe(true);
  });

  it('is false when any answer differs', () => {
    expect(matchesWildcard(info(['192.0.2.77', '203.0.113.1']), wc)).toBe(false);
    expect(matchesWildcard(info([], ['2001:db8::1']), wc)).toBe(false);
    expect(matchesWildcard(info(['192.0.2.77'], [], ['other.example.net']), wc)).toBe(false);
  });

  it('treats a matching CNAME as the wildcard even if the target rotated addresses', () => {
    expect(matchesWildcard(info(['198.51.100.5'], [], ['lb.example.net']), wc)).toBe(true);
  });

  it('is false for an empty answer', () => {
    expect(matchesWildcard(info(), wc)).toBe(false);
  });

  it('tolerates malformed infos', () => {
    expect(matchesWildcard({ a: ['192.0.2.77'] } as unknown as DnsInfo, wc)).toBe(true);
    expect(matchesWildcard(null as unknown as DnsInfo, wc)).toBe(false);
  });
});
