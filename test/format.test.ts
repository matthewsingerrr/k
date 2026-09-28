import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { embedLength as djsEmbedLength, type APIEmbed } from 'discord.js';
import {
  ALERT_COLORS,
  clampEmbed,
  embedLength,
  escapeMarkdown,
  formatAlerts,
  formatBytes,
  formatDuration,
  type MessagePayload,
} from '../src/discord/format.js';
import { diffText } from '../src/diff/text.js';
import { pageTextSnapshot, parseHtml } from '../src/extract/html.js';
import { dynamicInfo, noiseInfo, pageLabel } from '../src/monitor/pages-text.js';
import {
  DEFAULT_FEATURES,
  type Alert,
  type DeployAlert,
  type FileAlert,
  type NewPagesAlert,
  type SubdomainAlert,
  type SubdomainInfo,
  type TextAlert,
  type TextDiff,
  type Watch,
} from '../src/types.js';

const GUILD = '111111111111111111';
const ROLE = '222222222222222222';
const NOW = new Date('2026-09-28T12:00:00.000Z');

function makeWatch(over: Partial<Watch> = {}): Watch {
  return {
    id: 7,
    guildId: GUILD,
    channelId: '333333333333333333',
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
    createdBy: 'u',
    createdAt: 0,
    ...over,
  };
}

function makeDiff(unified: string, hash = 'h' + unified.length): TextDiff {
  return { added: ['x'], removed: ['y'], numericOnly: false, unified, hash };
}

function textAlert(entries: Array<{ url: string; title?: string | null; unified: string; hash?: string }>): TextAlert {
  const changes = entries.map((e) => ({
    url: e.url,
    title: e.title ?? null,
    diff: makeDiff(e.unified, e.hash ?? e.url),
    titleChange: null,
  }));
  const groups = new Map<string, { hash: string; urls: string[]; diff: TextDiff }>();
  for (const c of changes) {
    const g = groups.get(c.diff.hash);
    if (g) g.urls.push(c.url);
    else groups.set(c.diff.hash, { hash: c.diff.hash, urls: [c.url], diff: c.diff });
  }
  return { kind: 'text', changes, groups: [...groups.values()].sort((a, b) => b.urls.length - a.urls.length) };
}

function sub(host: string, over: Partial<SubdomainInfo> = {}): SubdomainInfo {
  return {
    host,
    sources: ['ct'],
    dns: { a: ['76.76.21.21'], aaaa: [], cname: [] },
    http: { status: 200, title: 'Beta', finalUrl: `https://${host}/`, server: 'Vercel' },
    ...over,
  };
}

const fenceCount = (s: string) => (s.match(/```/g) ?? []).length;

/** Every Discord limit the notifier relies on, checked independently of the implementation. */
function assertDiscordLimits(p: MessagePayload): void {
  const content = p.content ?? '';
  expect(content.length).toBeLessThanOrEqual(2000);
  expect(p.embeds.length > 0 || content.length > 0).toBe(true);
  expect(p.embeds.length).toBeLessThanOrEqual(10);
  let total = 0;
  for (const e of p.embeds) {
    if (e.title !== undefined) {
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.title.length).toBeLessThanOrEqual(256);
    }
    if (e.description !== undefined) {
      expect(e.description.length).toBeGreaterThan(0);
      expect(e.description.length).toBeLessThanOrEqual(4096);
      expect(fenceCount(e.description) % 2).toBe(0);
    }
    expect(e.fields?.length ?? 0).toBeLessThanOrEqual(25);
    for (const f of e.fields ?? []) {
      expect(f.name.length).toBeGreaterThan(0);
      expect(f.name.length).toBeLessThanOrEqual(256);
      expect(f.value.length).toBeGreaterThan(0);
      expect(f.value.length).toBeLessThanOrEqual(1024);
    }
    if (e.footer) expect(e.footer.text.length).toBeLessThanOrEqual(2048);
    if (e.url !== undefined) expect(new URL(e.url).protocol).toMatch(/^https?:$/);
    if (e.color !== undefined) expect(e.color).toBeLessThanOrEqual(0xffffff);
    total += djsEmbedLength(e);
  }
  expect(total).toBeLessThanOrEqual(6000);
  expect(p.components?.length ?? 0).toBeLessThanOrEqual(5);
  const ids = new Set<string>();
  for (const row of p.components ?? []) {
    expect(row.components.length).toBeGreaterThan(0);
    expect(row.components.length).toBeLessThanOrEqual(5);
    for (const b of row.components) {
      const id = (b as { custom_id: string }).custom_id;
      expect(id.length).toBeLessThanOrEqual(100);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
      expect(((b as { label?: string }).label ?? '').length).toBeLessThanOrEqual(80);
    }
  }
  // Pings only through allowedMentions: either nothing, exactly the ping role, or @everyone for the everyone role.
  const am = p.allowedMentions;
  if (am.roles) {
    expect(am.parse).toBeUndefined();
    for (const r of am.roles) expect(content).toContain(`<@&${r}>`);
  } else {
    expect(am.parse === undefined || am.parse.length === 0 || (am.parse.length === 1 && am.parse[0] === 'everyone')).toBe(true);
  }
}

function assertAll(payloads: MessagePayload[]): void {
  expect(payloads.length).toBeGreaterThan(0);
  for (const p of payloads) assertDiscordLimits(p);
}

// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [999, '0s'],
    [45_000, '45s'],
    [240_000, '4m'],
    [252_000, '4m 12s'],
    [3 * 3600_000, '3h'],
    [3 * 3600_000 + 5 * 60_000 + 7_000, '3h 5m'],
    [2 * 86_400_000 + 4 * 3600_000, '2d 4h'],
    [5 * 86_400_000, '5d'],
    [-5, '0s'],
    [Number.NaN, '0s'],
    [Number.POSITIVE_INFINITY, '0s'],
  ])('%s ms → %s', (ms, out) => {
    expect(formatDuration(ms)).toBe(out);
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [820, '820 B'],
    [1024, '1 KB'],
    [12_595, '12.3 KB'],
    [820 * 1024, '820 KB'],
    [863 * 1024, '863 KB'],
    [4.1 * 1024 * 1024, '4.1 MB'],
    [3 * 1024 ** 3, '3 GB'],
    [null, '?'],
    [-1, '?'],
    [Number.NaN, '?'],
  ])('%s → %s', (n, out) => {
    expect(formatBytes(n as number | null)).toBe(out);
  });
});

describe('escapeMarkdown', () => {
  it('escapes inline markdown', () => {
    expect(escapeMarkdown('a*b_c~d`e|f')).toBe('a\\*b\\_c~d\\`e|f');
    expect(escapeMarkdown('||spoiler|| ~~strike~~')).toBe('\\|\\|spoiler\\|\\| \\~\\~strike\\~\\~');
    expect(escapeMarkdown('[x](https://evil.example)')).toBe('\\[x\\](https://evil.example)');
    expect(escapeMarkdown('<@&123> <t:1:R>')).toBe('\\<@&123> \\<t:1:R>');
    expect(escapeMarkdown('back\\slash')).toBe('back\\\\slash');
  });

  it('escapes line-start markers', () => {
    expect(escapeMarkdown('# Title')).toBe('\\# Title');
    expect(escapeMarkdown('- item\n  > quote\n1. one')).toBe('\\- item\n  \\> quote\n1\\. one');
    expect(escapeMarkdown('a - b # c')).toBe('a - b # c');
  });

  it('defangs mass mentions and tolerates non-strings', () => {
    expect(escapeMarkdown('@everyone @here')).toBe('@\u200beveryone @\u200bhere');
    expect(escapeMarkdown(undefined as unknown as string)).toBe('');
  });
});

describe('embedLength / clampEmbed', () => {
  it('counts like Discord', () => {
    const e: APIEmbed = { title: 'ab', description: 'cde', fields: [{ name: 'f', value: 'gh' }], footer: { text: 'ij' }, author: { name: 'k' } };
    expect(embedLength(e)).toBe(11);
    expect(embedLength(e)).toBe(djsEmbedLength(e));
    expect(embedLength({})).toBe(0);
  });

  it('clamps every limit and the 6000 total', () => {
    const e = clampEmbed({
      title: 'T'.repeat(1000),
      description: '```diff\n' + '+ x\n'.repeat(3000) + '```',
      url: 'javascript:alert(1)',
      fields: Array.from({ length: 40 }, (_, n) => ({ name: n % 2 ? '' : 'N'.repeat(500), value: n % 3 ? 'V'.repeat(3000) : '   ' })),
      footer: { text: 'F'.repeat(5000) },
      color: 0x1000000,
    });
    assertDiscordLimits({ embeds: [e], allowedMentions: { parse: [] } });
    expect(e.url).toBeUndefined();
    expect(e.color).toBeUndefined();
  });

  it('never splits surrogate pairs or leaves a dangling escape', () => {
    const e = clampEmbed({ title: '😀'.repeat(300), description: 'a\\'.repeat(3000) });
    expect(e.title!.length).toBeLessThanOrEqual(256);
    expect(e.title!.endsWith('…')).toBe(true);
    // No lone high surrogate before the ellipsis.
    const beforeEllipsis = e.title!.charCodeAt(e.title!.length - 2);
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
    expect(/(^|[^\\])(\\\\)*\\…$/.test(e.description!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('formatAlerts — per kind', () => {
  const watch = makeWatch();

  it('returns nothing for no alerts', () => {
    expect(formatAlerts(watch, [], NOW)).toEqual([]);
    expect(formatAlerts(watch, null as unknown as Alert[], NOW)).toEqual([]);
  });

  it('deploy', () => {
    const alert: DeployAlert = {
      kind: 'deploy',
      url: 'https://unpeg.io/',
      host: 'unpeg.io',
      buildIdOld: 'KU79old',
      buildIdNew: 'ZZ12new',
      assetsAdded: ['https://unpeg.io/_next/static/chunks/app/page-abc.js', 'https://unpeg.io/_next/static/css/x.css'],
      assetsRemoved: ['https://unpeg.io/_next/static/chunks/app/page-old.js'],
      newCodePaths: ['/docs/points', '/api/v1/claim'],
      newCodeHosts: ['api.unpeg.io'],
    };
    const [p, ...rest] = formatAlerts(watch, [alert], NOW);
    expect(rest).toHaveLength(0);
    expect(p.content).toBe('🌐 **unpeg.io** was redeployed (site code changed).');
    expect(p.allowedMentions).toEqual({ parse: [] });
    const e = p.embeds[0];
    expect(e.title).toBe('unpeg.io redeployed');
    expect(e.url).toBe('https://unpeg.io/');
    expect(e.color).toBe(ALERT_COLORS.deploy);
    expect(e.footer?.text).toBe('Unpeg · unpeg.io');
    expect(e.timestamp).toBe(NOW.toISOString());
    const fields = Object.fromEntries((e.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields.Build).toBe('`KU79old` → `ZZ12new`');
    expect(fields.Bundles).toBe('+2 / −1 changed\n`/_next/static/chunks/app/page-abc.js`\n`/_next/static/css/x.css`');
    expect(fields['New routes in code']).toBe('`/docs/points`\n`/api/v1/claim`');
    expect(fields['New hosts in code']).toBe('`api.unpeg.io`');
  });

  it('deploy with unchanged / unknown build id', () => {
    const base: DeployAlert = {
      kind: 'deploy', url: 'https://unpeg.io/', host: 'unpeg.io', buildIdOld: null, buildIdNew: null,
      assetsAdded: ['https://unpeg.io/a.js'], assetsRemoved: [], newCodePaths: [], newCodeHosts: [],
    };
    let e = formatAlerts(watch, [base], NOW)[0].embeds[0];
    expect(e.fields?.map((f) => f.name)).toEqual(['Bundles']);
    e = formatAlerts(watch, [{ ...base, buildIdOld: 'b1', buildIdNew: 'b1' }], NOW)[0].embeds[0];
    expect(e.fields?.[0]).toEqual({ name: 'Build', value: '`b1` (unchanged)' });
    e = formatAlerts(watch, [{ ...base, buildIdOld: null, buildIdNew: 'b2' }], NOW)[0].embeds[0];
    expect(e.fields?.[0].value).toBe('— → `b2`');
  });

  it('text: content lists paths with (+N more), one embed per diff group', () => {
    const paths = ['/docs/risks', '/docs/guides', '/docs/faq', '/docs/a', '/docs/b', '/docs/c', '/docs/d'];
    const alert = textAlert(paths.map((p, n) => ({ url: `https://unpeg.io${p}`, title: n === 0 ? 'Risks | Unpeg Docs' : null, unified: `- old ${n}\n+ new ${n}` })));
    const payloads = formatAlerts(watch, [alert], NOW);
    assertAll(payloads);
    expect(payloads[0].content).toBe('📝 **Unpeg** text changed: /docs/risks, /docs/guides, /docs/faq, /docs/a, /docs/b (+2 more)');
    const embeds = payloads.flatMap((p) => p.embeds);
    expect(embeds).toHaveLength(7);
    expect(embeds[0].title).toBe('Risks | Unpeg Docs');
    expect(embeds[0].url).toBe('https://unpeg.io/docs/risks');
    expect(embeds[0].description).toBe('```diff\n- old 0\n+ new 0\n```');
    expect(embeds[1].title).toBe('/docs/guides');
    expect(embeds[0].color).toBe(ALERT_COLORS.text);
    // content only on the first payload of the alert
    expect(payloads.slice(1).every((p) => p.content === undefined)).toBe(true);
  });

  it('text: identical change on many pages is shown once', () => {
    const urls = ['/a', '/b', '/c'].map((p) => `https://unpeg.io/docs${p}`);
    const alert = textAlert(urls.map((url) => ({ url, unified: '- Nav: Old\n+ Nav: New', hash: 'same' })));
    const [p] = formatAlerts(watch, [alert], NOW);
    expect(p.embeds).toHaveLength(1);
    expect(p.embeds[0].description).toBe('Same change on 3 pages: /docs/a, /docs/b, /docs/c\n```diff\n- Nav: Old\n+ Nav: New\n```');
  });

  it('text: more than 8 groups → final "+N more pages changed"', () => {
    const alert = textAlert(Array.from({ length: 11 }, (_, n) => ({ url: `https://unpeg.io/p${n}`, unified: `+ line ${n}` })));
    const payloads = formatAlerts(watch, [alert], NOW);
    assertAll(payloads);
    const embeds = payloads.flatMap((p) => p.embeds);
    expect(embeds).toHaveLength(9);
    expect(embeds[8].description).toBe('+3 more pages changed: /p8, /p9, /p10');
  });

  it('text: sanitizes ``` inside diffs and escapes titles', () => {
    const alert = textAlert([{ url: 'https://unpeg.io/x', title: '**Big** _sale_ `now`', unified: '+ ```js\n+ evil()\n+ ```' }]);
    const e = formatAlerts(watch, [alert], NOW)[0].embeds[0];
    expect(e.title).toBe('\\*\\*Big\\*\\* \\_sale\\_ \\`now\\`');
    expect(e.description).toBe('```diff\n+ ˋˋˋjs\n+ evil()\n+ ˋˋˋ\n```');
  });

  it('text: title changes and title-only changes', () => {
    const alert: TextAlert = {
      kind: 'text',
      changes: [{ url: 'https://unpeg.io/', title: 'New', diff: makeDiff('', 'e'), titleChange: { from: 'Old `x`', to: 'New' } }],
      groups: [{ hash: 'e', urls: ['https://unpeg.io/'], diff: makeDiff('', 'e') }],
    };
    const e = formatAlerts(watch, [alert], NOW)[0].embeds[0];
    expect(e.description).toBe('Only the page title changed.');
    expect(e.fields).toEqual([{ name: 'Title', value: '`Old ˋxˋ` → `New`' }]);
  });

  it('text: rebuilds groups when the monitor sent none', () => {
    const alert = textAlert([{ url: 'https://unpeg.io/a', unified: '+ a' }]);
    alert.groups = [];
    const [p] = formatAlerts(watch, [alert], NOW);
    expect(p.embeds[0].description).toContain('+ a');
  });

  it('text: a big diff is cut at whole lines within 4000 chars and the block stays closed', () => {
    const unified = Array.from({ length: 30 }, (_, n) => `+ ${String(n).padStart(2, '0')} ${'x'.repeat(175)}`).join('\n');
    const e = formatAlerts(watch, [textAlert([{ url: 'https://unpeg.io/big', unified }])], NOW)[0].embeds[0];
    const d = e.description!;
    expect(d.length).toBeLessThanOrEqual(4000);
    expect(d.startsWith('```diff\n')).toBe(true);
    expect(d.endsWith('\n… (diff truncated)\n```')).toBe(true);
    for (const line of d.split('\n').slice(1, -2)) expect(line).toMatch(/^\+ \d\d x{175}$/);
  });

  it('new_pages', () => {
    const alert: NewPagesAlert = {
      kind: 'new_pages',
      pages: [
        { url: 'https://unpeg.io/docs/points', title: 'Points [beta]', source: 'link' },
        { url: 'https://unpeg.io/airdrop', title: null, source: 'code' },
        { url: 'https://unpeg.io/a_(b)', title: null, source: 'sitemap' },
      ],
    };
    const [p] = formatAlerts(watch, [alert], NOW);
    expect(p.content).toBe('🆕 **Unpeg** new pages: /docs/points, /airdrop, /a\\_(b)');
    const e = p.embeds[0];
    expect(e.title).toBe('3 new pages');
    expect(e.color).toBe(ALERT_COLORS.new_pages);
    expect(e.description).toBe(
      [
        '• [/docs/points](https://unpeg.io/docs/points) — Points \\[beta\\]',
        '• [/airdrop](https://unpeg.io/airdrop) · _found in site code_',
        '• [/a\\_(b)](https://unpeg.io/a_%28b%29) · _sitemap_',
      ].join('\n'),
    );
    expect(formatAlerts(watch, [{ kind: 'new_pages', pages: [alert.pages[0]] }], NOW)[0].content).toBe(
      '🆕 **Unpeg** new page: /docs/points',
    );
  });

  it('new_pages lists at most 25 then "…and N more"', () => {
    const pages = Array.from({ length: 40 }, (_, n) => ({ url: `https://unpeg.io/p${n}`, title: null, source: 'link' as const }));
    const [p] = formatAlerts(watch, [{ kind: 'new_pages', pages }], NOW);
    const lines = p.embeds[0].description!.split('\n');
    expect(lines).toHaveLength(26);
    expect(lines[25]).toBe('…and 15 more');
    expect(p.content).toBe('🆕 **Unpeg** new pages: /p0, /p1, /p2, /p3, /p4 (+35 more)');
  });

  it('removed_pages', () => {
    const [p] = formatAlerts(watch, [{ kind: 'removed_pages', pages: [{ url: 'https://unpeg.io/docs/old', status: 404 }] }], NOW);
    expect(p.content).toBe('🗑️ **Unpeg** page removed: /docs/old');
    expect(p.embeds[0].description).toBe('• /docs/old (HTTP 404)');
    expect(p.embeds[0].color).toBe(ALERT_COLORS.removed_pages);
    const [q] = formatAlerts(
      watch,
      [{ kind: 'removed_pages', pages: [{ url: 'https://unpeg.io/a', status: 410 }, { url: 'https://unpeg.io/b', status: 0 }] }],
      NOW,
    );
    expect(q.content).toBe('🗑️ **Unpeg** pages removed: /a, /b');
    expect(q.embeds[0].description).toBe('• /a (HTTP 410)\n• /b (unreachable)');
  });

  it('subdomain: one embed per host with buttons for live hosts only', () => {
    const alert: SubdomainAlert = {
      kind: 'subdomain',
      rootDomain: 'unpeg.io',
      subdomains: [
        sub('beta.unpeg.io', { sources: ['ct', 'dns'], dns: { a: ['1.1.1.1', '2.2.2.2'], aaaa: ['::1'], cname: ['cname.vercel-dns.com'] } }),
        sub('app.unpeg.io', { dns: { a: [], aaaa: [], cname: [] }, http: { status: 0, title: null, finalUrl: null, server: null } }),
      ],
    };
    const [p] = formatAlerts(watch, [alert], NOW);
    assertDiscordLimits(p);
    expect(p.content).toBe('🛰️ New subdomains on **unpeg.io**: beta.unpeg.io, app.unpeg.io');
    expect(p.embeds.map((e) => e.title)).toEqual(['beta.unpeg.io', 'app.unpeg.io']);
    expect(p.embeds[0].url).toBe('https://beta.unpeg.io/');
    expect(p.embeds[1].url).toBe('https://app.unpeg.io/');
    const f = Object.fromEntries(p.embeds[0].fields!.map((x) => [x.name, x.value]));
    expect(f['Found via']).toBe('Certificate log, DNS');
    expect(f.DNS).toBe('CNAME `cname.vercel-dns.com`\nA `1.1.1.1`, `2.2.2.2`\nAAAA `::1`');
    expect(f.HTTP).toBe('200 · Beta');
    expect(p.embeds[1].fields!.find((x) => x.name === 'HTTP')!.value).toBe('unreachable');
    expect(p.embeds[1].fields!.find((x) => x.name === 'DNS')!.value).toBe('no records');
    expect(p.components).toEqual([
      { type: 1, components: [{ type: 2, style: 2, label: 'Watch beta.unpeg.io', custom_id: 'watchsub:7:beta.unpeg.io' }] },
    ]);
  });

  it('subdomain_live and DNS value cap', () => {
    const many = { a: Array.from({ length: 9 }, (_, n) => `10.0.0.${n}`), aaaa: [], cname: [] };
    const [p] = formatAlerts(watch, [{ kind: 'subdomain_live', rootDomain: 'unpeg.io', subdomains: [sub('beta.unpeg.io', { dns: many })] }], NOW);
    expect(p.content).toBe('🟣 Subdomain went live: beta.unpeg.io');
    expect(p.embeds[0].fields!.find((x) => x.name === 'DNS')!.value).toBe(
      'A `10.0.0.0`, `10.0.0.1`, `10.0.0.2`, `10.0.0.3`, `10.0.0.4`, `10.0.0.5`\n+3 more',
    );
  });

  it('subdomains: > 10 → 9 detailed embeds + a compact list; ≤ 5 buttons; duplicates, the watched host and long hosts skipped', () => {
    const long = `${'a'.repeat(63)}.${'b'.repeat(20)}.unpeg.io`; // custom_id would exceed 100 chars
    const subs = [sub(long), sub('unpeg.io'), sub('dup.unpeg.io'), sub('dup.unpeg.io')];
    for (let n = 0; n < 10; n++) subs.push(sub(`s${n}.unpeg.io`));
    const payloads = formatAlerts(watch, [{ kind: 'subdomain', rootDomain: 'unpeg.io', subdomains: subs }], NOW);
    assertAll(payloads);
    const embeds = payloads.flatMap((p) => p.embeds);
    expect(embeds).toHaveLength(10);
    expect(embeds[9].title).toBe('…and 4 more');
    const ids = payloads.flatMap((p) => p.components ?? []).flatMap((r) => r.components.map((b) => (b as { custom_id: string }).custom_id));
    expect(ids).not.toContain(`watchsub:7:${long}`);
    expect(ids).not.toContain('watchsub:7:unpeg.io');
    expect(ids.filter((x) => x === 'watchsub:7:dup.unpeg.io')).toHaveLength(1);
    expect(ids[0]).toBe('watchsub:7:dup.unpeg.io');
  });

  it('file', () => {
    const alert: FileAlert = {
      kind: 'file',
      files: [{ url: 'https://unpeg.io/whitepaper.pdf', change: 'modified', oldSize: 820 * 1024, newSize: 863 * 1024, contentType: 'application/pdf' }],
    };
    const [p] = formatAlerts(watch, [alert], NOW);
    expect(p.content).toBe('📄 **Unpeg** file changed: whitepaper.pdf');
    expect(p.embeds[0].description).toBe('• [whitepaper.pdf](https://unpeg.io/whitepaper.pdf) — modified (820 KB → 863 KB)');
    expect(p.embeds[0].color).toBe(ALERT_COLORS.file);
    const [q] = formatAlerts(
      watch,
      [
        {
          kind: 'file',
          files: [
            { url: 'https://unpeg.io/a.md', change: 'added', oldSize: null, newSize: 2048, contentType: null },
            { url: 'https://unpeg.io/b.txt', change: 'added', oldSize: null, newSize: null, contentType: null },
          ],
        },
      ],
      NOW,
    );
    expect(q.content).toBe('📄 **Unpeg** new files: a.md, b.txt');
    expect(q.embeds[0].description).toBe('• [a.md](https://unpeg.io/a.md) — added (2 KB)\n• [b.txt](https://unpeg.io/b.txt) — added');
    const [r] = formatAlerts(watch, [{ kind: 'file', files: [{ url: 'https://unpeg.io/c.pdf', change: 'removed', oldSize: 1, newSize: null, contentType: null }] }], NOW);
    expect(r.content).toBe('📄 **Unpeg** file removed: c.pdf');
  });

  it('status down / up', () => {
    const [down] = formatAlerts(watch, [{ kind: 'status', url: 'https://unpeg.io/', up: false, detail: 'HTTP 502', downForMs: null }], NOW);
    expect(down.content).toBe('🔴 **unpeg.io** is DOWN (HTTP 502)');
    expect(down.embeds[0].color).toBe(ALERT_COLORS.statusDown);
    expect(down.embeds[0].description).toBe('[unpeg.io/](https://unpeg.io/)\n**Error:** HTTP 502');
    const [up] = formatAlerts(watch, [{ kind: 'status', url: 'https://unpeg.io/', up: true, detail: 'HTTP 200', downForMs: 252_000 }], NOW);
    expect(up.content).toBe('🟢 **unpeg.io** is back UP (was down 4m 12s)');
    expect(up.embeds[0].color).toBe(ALERT_COLORS.statusUp);
    expect(up.embeds[0].description).toContain('**Downtime:** 4m 12s');
  });

  it('info', () => {
    const [p] = formatAlerts(watch, [{ kind: 'info', message: 'Requests are being blocked (HTTP 403).\nSecond line' }], NOW);
    expect(p.content).toBe('ℹ️ **Unpeg**: Requests are being blocked (HTTP 403).');
    // Only what the content line does not already say goes into the embed.
    expect(p.embeds[0].description).toBe('Second line');
    expect(p.embeds[0].color).toBe(ALERT_COLORS.info);
  });

  it('info: no doubled emoji, site-controlled paths escaped, one-liners without an embed', () => {
    const [p] = formatAlerts(watch, [dynamicInfo(pageLabel('https://unpeg.io/docs/__init__/**b**', watch))], NOW);
    expect(p.content).toBe(
      'ℹ️ **Unpeg**: /docs/\\_\\_init\\_\\_/\\*\\*b\\*\\* changes on every load; ignoring its text. Use /watch ignore to filter the changing part.',
    );
    expect(p.content!.match(/ℹ️/g)).toHaveLength(1);
    expect(p.embeds).toEqual([]);
    const [w] = formatAlerts(watch, [{ kind: 'info', message: '⚠️ unpeg.io is showing a bot challenge' }], NOW);
    expect(w.content).toBe('⚠️ **Unpeg**: unpeg.io is showing a bot challenge');
    const [m] = formatAlerts(
      watch,
      [noiseInfo([{ kind: 'live', label: '/a' }, { kind: 'churn', label: '/b' }])!],
      NOW,
    );
    expect(m.content).toBe('ℹ️ **Unpeg**: Ignoring noisy text on 2 pages:');
    expect(m.embeds[0].description).toContain('number-only changes on the ticking lines of 1 page that show live numbers: /a');
  });

  it('deploy: a shared ?dpl= change is shown as the deployment id, with a short chunk list', () => {
    const chunks = Array.from({ length: 12 }, (_, n) => `/_next/static/chunks/${n}-zr5qv${n}.js`);
    const alert: DeployAlert = {
      kind: 'deploy', url: 'https://pump.fun/', host: 'pump.fun', buildIdOld: null, buildIdNew: null,
      assetsAdded: chunks.map((c) => `${c}?dpl=dpl_FYbz69QceRX9`),
      assetsRemoved: chunks.map((c) => `${c}?dpl=dpl_Old123`),
      newCodePaths: [], newCodeHosts: [],
    };
    const e = formatAlerts(watch, [alert], NOW)[0].embeds[0];
    const fields = Object.fromEntries((e.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields.Deployment).toBe('`dpl_Old123` → `dpl_FYbz69QceRX9`');
    expect(fields.Bundles.split('\n')).toHaveLength(1 + 3 + 1); // header, 3 chunks, "…and 9 more"
  });

  it('subdomains redirecting to the watched site share no embed url and get no "Watch" button', () => {
    const toHome = { status: 200, title: 'Unpeg', finalUrl: 'https://unpeg.io/', server: null };
    const [p] = formatAlerts(
      watch,
      [{ kind: 'subdomain', rootDomain: 'unpeg.io', subdomains: ['www', 'home', 'app'].map((l) => sub(`${l}.unpeg.io`, { http: toHome })) }],
      NOW,
    );
    expect(p.embeds.map((e) => e.url)).toEqual(['https://www.unpeg.io/', 'https://home.unpeg.io/', 'https://app.unpeg.io/']);
    expect(p.components ?? []).toEqual([]);
    expect(p.embeds[2].fields!.find((f) => f.name === 'HTTP')!.value).toBe('200 · Unpeg → unpeg.io');
  });

  it('keeps alert order and one content per alert', () => {
    const alerts: Alert[] = [
      { kind: 'deploy', url: 'https://unpeg.io/', host: 'unpeg.io', buildIdOld: 'a', buildIdNew: 'b', assetsAdded: [], assetsRemoved: [], newCodePaths: [], newCodeHosts: [] },
      textAlert([{ url: 'https://unpeg.io/docs/risks', unified: '+ x' }]),
      { kind: 'info', message: 'hi' },
    ];
    const payloads = formatAlerts(watch, alerts, NOW);
    expect(payloads.map((p) => p.content?.slice(0, 2))).toEqual(['🌐', '📝', 'ℹ️']);
  });
});

describe('formatAlerts — pings', () => {
  const deploy: DeployAlert = {
    kind: 'deploy', url: 'https://unpeg.io/', host: 'unpeg.io', buildIdOld: 'a', buildIdNew: 'b',
    assetsAdded: [], assetsRemoved: [], newCodePaths: [], newCodeHosts: [],
  };

  it('pings the role once per batch, only via allowedMentions.roles', () => {
    const payloads = formatAlerts(makeWatch({ pingRoleId: ROLE }), [deploy, { kind: 'info', message: 'x' }], NOW);
    expect(payloads[0].content).toBe(`<@&${ROLE}> 🌐 **unpeg.io** was redeployed (site code changed).`);
    expect(payloads[0].allowedMentions).toEqual({ roles: [ROLE] });
    expect(payloads[1].content).not.toContain('<@&');
    expect(payloads[1].allowedMentions).toEqual({ parse: [] });
  });

  it('the @everyone role (id = guild id) pings @everyone', () => {
    const [p] = formatAlerts(makeWatch({ pingRoleId: GUILD }), [deploy], NOW);
    expect(p.content!.startsWith('@everyone ')).toBe(true);
    expect(p.allowedMentions).toEqual({ parse: ['everyone'] });
  });

  it('ignores malformed role ids and never lets content mention anyone', () => {
    const watch = makeWatch({ pingRoleId: 'abc', name: '@everyone <@&999999999999999999>' });
    const [p] = formatAlerts(watch, [{ kind: 'info', message: 'hi @here' }], NOW);
    expect(p.allowedMentions).toEqual({ parse: [] });
    expect(p.content).toContain('@\u200beveryone \\<@&999999999999999999>');
  });
});

// ---------------------------------------------------------------------------
// Property-style limit tests
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NASTY = ['*', '_', '~', '`', '```', '|', '||', '[', ']', '(', ')', '<', '>', '#', '-', '\\', '@everyone', '<@&1>', '\n', ' ', '😀', 'é', 'x', 'abc', '%', '"'];

function nasty(r: () => number, maxLen: number): string {
  const len = Math.floor(r() * maxLen);
  let s = '';
  while (s.length < len) s += NASTY[Math.floor(r() * NASTY.length)];
  return s;
}

describe('formatAlerts — Discord limits under huge alerts', () => {
  const hugeWatch = makeWatch({ name: 'W*_`'.repeat(2000), pingRoleId: ROLE });

  it('100 changed pages with 5k-char diffs', () => {
    const r = rng(1);
    const entries = Array.from({ length: 100 }, (_, n) => ({
      url: `https://unpeg.io/docs/${'seg_'.repeat(20)}${n}`,
      title: nasty(r, 400) || null,
      unified: Array.from({ length: 30 }, () => `${r() < 0.5 ? '+' : '-'} ${nasty(r, 180)}`).join('\n').slice(0, 5000),
    }));
    const alert = textAlert(entries);
    alert.changes[3].titleChange = { from: 'x'.repeat(3000), to: '```'.repeat(500) };
    for (const watch of [makeWatch(), hugeWatch]) {
      const payloads = formatAlerts(watch, [alert], NOW);
      assertAll(payloads);
      expect(payloads.filter((p) => p.content !== undefined)).toHaveLength(1);
      // More than 20 pages changed: 3 group embeds + the "more pages" embed
      expect(payloads.flatMap((p) => p.embeds)).toHaveLength(4);
    }
    // Per-group diff budgets shrink with the group count, so a big tick stays within a few messages.
    const plain = textAlert(entries.map((e) => ({ ...e, title: 'Docs' })));
    expect(formatAlerts(makeWatch(), [plain], NOW).length).toBeLessThanOrEqual(2);
  });

  it('a single group whose diff lines are huge', () => {
    const unified = Array.from({ length: 200 }, (_, n) => `+ ${'`'.repeat(n % 7)}${'w'.repeat(5000)}`).join('\n');
    assertAll(formatAlerts(hugeWatch, [textAlert([{ url: 'https://unpeg.io/', unified }])], NOW));
  });

  it('300 new pages with long markdown-laden titles', () => {
    const r = rng(2);
    const pages = Array.from({ length: 300 }, (_, n) => ({
      url: `https://unpeg.io/p/${n}/${'x'.repeat(Math.floor(r() * 3000))}`,
      title: nasty(r, 2000),
      source: (['link', 'sitemap', 'code', 'extra', 'redirect', 'start'] as const)[n % 6],
    }));
    const payloads = formatAlerts(hugeWatch, [{ kind: 'new_pages', pages }], NOW);
    assertAll(payloads);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].content).toContain('(+');
  });

  it('60 subdomains with lots of DNS values and hostile titles', () => {
    const r = rng(3);
    const subs = Array.from({ length: 60 }, (_, n) =>
      sub(`${n % 5 === 0 ? 'x'.repeat(60) + '.' : ''}s${n}.unpeg.io`, {
        sources: ['ct', 'crtsh', 'dns', 'link', 'code'],
        dns: n % 7 === 0 ? null : { a: Array.from({ length: 20 }, (_, k) => `10.0.${n}.${k}`), aaaa: ['2001:db8::1'], cname: [nasty(r, 300)] },
        http: n % 3 === 0 ? null : { status: 200 + n, title: nasty(r, 3000), finalUrl: n % 4 ? `https://${nasty(r, 50)}` : 'not a url', server: null },
      }),
    );
    for (const kind of ['subdomain', 'subdomain_live'] as const) {
      const payloads = formatAlerts(hugeWatch, [{ kind, rootDomain: 'unpeg.io'.repeat(50), subdomains: subs }], NOW);
      assertAll(payloads);
      expect(payloads.flatMap((p) => p.embeds)).toHaveLength(10);
      expect(payloads.flatMap((p) => p.components ?? []).length).toBeGreaterThan(0);
    }
  });

  it('deploy with enormous asset / route / host lists and build ids', () => {
    const alert: DeployAlert = {
      kind: 'deploy',
      url: 'https://unpeg.io/',
      host: 'unpeg.io',
      buildIdOld: 'o'.repeat(5000),
      buildIdNew: '`'.repeat(5000),
      assetsAdded: Array.from({ length: 500 }, (_, n) => `https://unpeg.io/_next/static/chunks/${'c'.repeat(300)}-${n}.js`),
      assetsRemoved: Array.from({ length: 400 }, (_, n) => `https://unpeg.io/old-${n}.js`),
      newCodePaths: Array.from({ length: 1000 }, (_, n) => `/route/${'r'.repeat(n % 500)}`),
      newCodeHosts: Array.from({ length: 500 }, (_, n) => `h${n}.${'z'.repeat(200)}.io`),
    };
    assertAll(formatAlerts(hugeWatch, [alert], NOW));
  });

  it('files, removed pages, status and info at extreme sizes', () => {
    const r = rng(4);
    const alerts: Alert[] = [
      {
        kind: 'file',
        files: Array.from({ length: 200 }, (_, n) => ({
          url: `https://unpeg.io/${nasty(r, 400)}${n}.pdf`,
          change: (['added', 'modified', 'removed'] as const)[n % 3],
          oldSize: n * 1000,
          newSize: n % 2 ? null : n * 2000,
          contentType: 'application/pdf',
        })),
      },
      { kind: 'removed_pages', pages: Array.from({ length: 400 }, (_, n) => ({ url: `https://unpeg.io/${nasty(r, 500)}${n}`, status: 404 })) },
      { kind: 'status', url: 'https://unpeg.io/' + 'p'.repeat(5000), up: false, detail: nasty(r, 10_000), downForMs: null },
      { kind: 'status', url: 'not a url', up: true, detail: '', downForMs: 1e12 },
      { kind: 'info', message: '```' + nasty(r, 20_000) },
    ];
    const payloads = formatAlerts(hugeWatch, alerts, NOW);
    assertAll(payloads);
    expect(payloads.filter((p) => p.content !== undefined)).toHaveLength(alerts.length);
  });

  it('randomized alerts never throw and always respect the limits', () => {
    const r = rng(42);
    const url = () => (r() < 0.1 ? nasty(r, 60) : `https://${r() < 0.8 ? 'unpeg.io' : 'other.example'}/${encodeURI(nasty(r, 300))}`);
    const makeAlert = (): Alert => {
      switch (Math.floor(r() * 8)) {
        case 0:
          return {
            kind: 'deploy', url: url(), host: nasty(r, 300), buildIdOld: r() < 0.5 ? null : nasty(r, 300), buildIdNew: nasty(r, 300),
            assetsAdded: Array.from({ length: Math.floor(r() * 50) }, url), assetsRemoved: Array.from({ length: Math.floor(r() * 50) }, url),
            newCodePaths: Array.from({ length: Math.floor(r() * 50) }, () => nasty(r, 200)), newCodeHosts: Array.from({ length: Math.floor(r() * 30) }, () => nasty(r, 100)),
          };
        case 1:
          return textAlert(Array.from({ length: 1 + Math.floor(r() * 20) }, () => ({ url: url(), title: r() < 0.5 ? null : nasty(r, 500), unified: nasty(r, 6000), hash: String(Math.floor(r() * 5)) })));
        case 2:
          return { kind: 'new_pages', pages: Array.from({ length: Math.floor(r() * 80) }, () => ({ url: url(), title: r() < 0.5 ? null : nasty(r, 400), source: 'link' as const })) };
        case 3:
          return { kind: 'removed_pages', pages: Array.from({ length: Math.floor(r() * 80) }, () => ({ url: url(), status: Math.floor(r() * 600) })) };
        case 4:
          return {
            kind: r() < 0.5 ? 'subdomain' : 'subdomain_live',
            rootDomain: nasty(r, 100),
            subdomains: Array.from({ length: Math.floor(r() * 25) }, () =>
              sub(`${nasty(r, 40).replace(/[^a-z0-9.-]/gi, '') || 'x'}.unpeg.io`, { http: r() < 0.5 ? null : { status: 200, title: nasty(r, 400), finalUrl: url(), server: null } }),
            ),
          };
        case 5:
          return { kind: 'file', files: Array.from({ length: Math.floor(r() * 40) }, () => ({ url: url(), change: 'modified' as const, oldSize: r() * 1e9, newSize: null, contentType: null })) };
        case 6:
          return { kind: 'status', url: url(), up: r() < 0.5, detail: nasty(r, 500), downForMs: r() < 0.5 ? null : r() * 1e10 };
        default:
          return { kind: 'info', message: nasty(r, 5000) };
      }
    };
    for (let n = 0; n < 150; n++) {
      const watch = makeWatch({ name: nasty(r, 300) || 'x', pingRoleId: r() < 0.3 ? ROLE : null, host: r() < 0.9 ? 'unpeg.io' : nasty(r, 30) });
      const alerts = Array.from({ length: 1 + Math.floor(r() * 4) }, makeAlert);
      let payloads: MessagePayload[] = [];
      expect(() => (payloads = formatAlerts(watch, alerts, NOW))).not.toThrow();
      assertAll(payloads);
    }
  });

  it('malformed alerts fall back instead of throwing', () => {
    const junk = [
      { kind: 'text' },
      { kind: 'new_pages', pages: null },
      { kind: 'subdomain', subdomains: [null, { host: null }] },
      { kind: 'file', files: [{ url: 'https://unpeg.io/a.pdf', change: 'weird' }] },
      { kind: 'status' },
      { kind: 'mystery' },
      { kind: 'deploy' },
    ] as unknown as Alert[];
    let payloads: MessagePayload[] = [];
    expect(() => (payloads = formatAlerts(makeWatch(), junk, new Date(Number.NaN)))).not.toThrow();
    assertAll(payloads);
    expect(payloads.find((p) => p.content?.includes('mystery'))).toBeDefined();
  });
});

describe('formatAlerts — real Next.js fixtures', () => {
  it('renders a diff between the unpeg.io home and docs pages', () => {
    const home = parseHtml(readFileSync(new URL('./fixtures/nextjs-app-home.html', import.meta.url), 'utf8'), 'https://unpeg.io/');
    const docs = parseHtml(readFileSync(new URL('./fixtures/nextjs-app-docs.html', import.meta.url), 'utf8'), 'https://unpeg.io/docs');
    const diff = diffText(pageTextSnapshot(home), pageTextSnapshot(docs));
    const alert: TextAlert = {
      kind: 'text',
      changes: [{ url: 'https://unpeg.io/docs', title: docs.title, diff, titleChange: { from: home.title, to: docs.title } }],
      groups: [{ hash: diff.hash, urls: ['https://unpeg.io/docs'], diff }],
    };
    const payloads = formatAlerts(makeWatch(), [alert], NOW);
    assertAll(payloads);
    const e = payloads[0].embeds[0];
    expect(payloads[0].content).toBe('📝 **Unpeg** text changed: /docs');
    expect(e.url).toBe('https://unpeg.io/docs');
    expect(e.description!.startsWith('```diff\n')).toBe(true);
    expect(e.description!.endsWith('\n```')).toBe(true);
    expect(e.fields?.[0].name).toBe('Title');
  });
});
