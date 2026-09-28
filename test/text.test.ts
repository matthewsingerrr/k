import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyIgnorePatterns,
  compareText,
  diffText,
  MAX_DIFF_LINE_CHARS,
  maskNumbers,
  normalizeRelativeTimes,
  pairWindow,
  PatternTimeoutError,
  sha1,
} from '../src/diff/text.js';

const lines = (n: number, f: (i: number) => string = (i) => `line ${i} of the document`): string[] =>
  Array.from({ length: n }, (_, i) => f(i));

/** Every unified line must render sensibly in a ```diff block. */
function expectWellFormedUnified(unified: string): void {
  if (unified === '') return;
  for (const l of unified.split('\n')) {
    expect(l === '…' || l.startsWith('- ') || l.startsWith('+ ') || l.startsWith('  ') || /^… \(\+\d+ more changed lines\)$/.test(l)).toBe(true);
  }
}

describe('sha1', () => {
  it('matches known vectors', () => {
    expect(sha1('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('hashes strings as utf-8 and agrees with Buffers', () => {
    expect(sha1('héllo €')).toBe(sha1(Buffer.from('héllo €', 'utf8')));
    expect(sha1(Buffer.alloc(0))).toBe(sha1(''));
  });
});

describe('maskNumbers', () => {
  it.each([
    ['1,234.56', '#'],
    ['$12.5M', '$#M'],
    ['+3.2%', '#%'],
    ['-0.5', '#'],
    ['v1.2.3', 'v#'],
    ['2026-09-28', '#-#-#'],
    ['14:43', '#:#'],
    ['12:30:45', '#:#:#'],
    ['TVL $1,234,567.89 (+2.5%)', 'TVL $# (#%)'],
    ['a-5', 'a-#'],
    ['(−4)', '(#)'],
    ['Block 19234567', 'Block #'],
    ['1, 2, 3', '#, #, #'],
    ['version 2.', 'version #.'],
    ['no digits here', 'no digits here'],
    ['', ''],
  ])('%j → %j', (input, expected) => {
    expect(maskNumbers(input)).toBe(expected);
  });

  it('masks relative-time phrases so different magnitudes compare equal', () => {
    const variants = ['Updated 5 minutes ago', 'Updated 1 minute ago', 'Updated an hour ago', 'Updated 3h ago', 'Updated just now', 'Updated a few seconds ago'];
    const masked = new Set(variants.map(maskNumbers));
    expect(masked.size).toBe(1);
    expect(maskNumbers('Updated 5 minutes ago')).toBe('Updated # ago');
  });

  it('treats singular/plural counts as number-only', () => {
    expect(maskNumbers('1 item')).toBe(maskNumbers('2 items'));
    expect(maskNumbers('1 comment')).toBe(maskNumbers('24 comments'));
    expect(maskNumbers('in 1 day')).toBe(maskNumbers('in 3 days'));
  });

  it('does not mask words or equate different wording', () => {
    expect(maskNumbers('Claim 5 tokens')).not.toBe(maskNumbers('Stake 5 tokens'));
    expect(maskNumbers('abc-def')).toBe('abc-def');
  });

  it('masks non-ASCII decimal digits', () => {
    expect(maskNumbers('١٢٣ items')).toBe(maskNumbers('4 items'));
  });

  it('is fast on large inputs', () => {
    const big = lines(20_000, (i) => `Row ${i}: $${i * 3}.50 (+${i % 7}.1%) at 12:${String(i % 60).padStart(2, '0')}`).join('\n');
    const t = performance.now();
    const out = maskNumbers(big);
    expect(performance.now() - t).toBeLessThan(500);
    expect(out.split('\n')[5]).toBe('Row #: $# (#%) at #:#');
  });
});

describe('applyIgnorePatterns', () => {
  it('removes matches line by line, case-insensitively, and drops lines that become empty', () => {
    const text = 'Welcome\nLast updated 12:30 UTC\nPrice: 5\nSERVER TIME 99';
    expect(applyIgnorePatterns(text, ['last updated [\\d:]+ utc', 'server time \\d+'])).toBe('Welcome\nPrice: 5');
  });

  it('collapses whitespace and removes blank lines even without patterns', () => {
    expect(applyIgnorePatterns('  a   b \n\n\t\n c\t d  \r\n', [])).toBe('a b\nc d');
  });

  it('matches patterns against whitespace-collapsed lines', () => {
    expect(applyIgnorePatterns('Visitors   online:  42 now', ['visitors online: \\d+'])).toBe('now');
  });

  it('keeps partial remainders of a line', () => {
    expect(applyIgnorePatterns('Total 42 users (session abc123)', ['\\(session \\w+\\)'])).toBe('Total 42 users');
  });

  it('never matches across lines', () => {
    expect(applyIgnorePatterns('foo\nbar', ['foo\\nbar', 'foo[\\s\\S]*bar'])).toBe('foo\nbar');
  });

  it('skips invalid or non-string patterns silently', () => {
    expect(applyIgnorePatterns('keep [x]\ndrop me', ['[', '(unclosed', '', 'drop me'])).toBe('keep [x]');
    expect(applyIgnorePatterns('a 1', [42 as unknown as string, null as unknown as string, '\\d'])).toBe('a');
    expect(applyIgnorePatterns('a', undefined as unknown as string[])).toBe('a');
  });

  it('handles empty-matching patterns without looping', () => {
    expect(applyIgnorePatterns('abc', ['x*', '(?:)'])).toBe('abc');
  });

  it('is stable when the same global regex is reused many times', () => {
    const pats = ['\\d+'];
    for (let i = 0; i < 5; i++) expect(applyIgnorePatterns('a 1 b 22 c 333', pats)).toBe('a b c');
  });

  it('stops a catastrophically slow pattern instead of freezing the process', () => {
    const t0 = Date.now();
    let thrown: unknown = null;
    try {
      applyIgnorePatterns('a'.repeat(200_000), ['\\w+@']);
    } catch (err) {
      thrown = err;
    }
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(thrown).toBeInstanceOf(PatternTimeoutError);
    // Ordinary patterns on long prose are fine.
    const prose = Array.from({ length: 400 }, (_, i) => `Posted ${i} minutes ago by someone about something`).join(' ');
    expect(applyIgnorePatterns(prose, ['\\d+ minutes ago'])).not.toMatch(/minutes ago/);
  });

  it('handles empty/nullish text', () => {
    expect(applyIgnorePatterns('', ['x'])).toBe('');
    expect(applyIgnorePatterns(undefined as unknown as string, [])).toBe('');
  });
});

describe('compareText', () => {
  it('applies ignore patterns then masking', () => {
    const text = 'Stats\nUsers: 1,234\nRendered at 2026-09-28 14:43';
    expect(compareText(text, { ignorePatterns: ['^rendered at .*$'], maskNumbers: false })).toBe('Stats\nUsers: 1,234');
    expect(compareText(text, { ignorePatterns: ['^rendered at .*$'], maskNumbers: true })).toBe('Stats\nUsers: #');
  });

  it('gives equal output for number-only changes when masking', () => {
    const a = compareText('Price $1.00\nVolume 12M', { ignorePatterns: [], maskNumbers: true });
    const b = compareText('Price $1.07\nVolume 13.5M', { ignorePatterns: [], maskNumbers: true });
    expect(a).toBe(b);
    expect(sha1(a)).toBe(sha1(b));
  });

  it('always normalizes relative times, even without number masking', () => {
    const opts = { ignorePatterns: [], maskNumbers: false };
    expect(compareText('posted 59 minutes ago', opts)).toBe(compareText('posted 1 hour ago', opts));
    expect(compareText('2h ago', opts)).toBe(compareText('3h ago', opts));
    expect(compareText('Fee: 0.3%', opts)).not.toBe(compareText('Fee: 0.5%', opts));
    expect(normalizeRelativeTimes('updated just now · 5 mins ago · v2 on 2026-10-01')).toBe('updated # ago · # ago · v2 on 2026-10-01');
  });

  it('is whitespace-insensitive (formatting-only changes do not change the hash)', () => {
    const a = compareText('Hello  world\n\nFooter', { ignorePatterns: [], maskNumbers: false });
    const b = compareText('Hello world\nFooter\n', { ignorePatterns: [], maskNumbers: false });
    expect(a).toBe(b);
  });
});

describe('diffText', () => {
  it('reports nothing for identical texts', () => {
    const t = 'a\nb\nc';
    const d = diffText(t, t);
    expect(d).toEqual({
      added: [],
      removed: [],
      numericOnly: false,
      unified: '',
      hash: sha1(JSON.stringify([[], []])),
    });
    expect(diffText('', '').unified).toBe('');
  });

  it('treats an empty old text as everything added', () => {
    const d = diffText('', 'one\ntwo\nthree');
    expect(d.added).toEqual(['one', 'two', 'three']);
    expect(d.removed).toEqual([]);
    expect(d.unified).toBe('+ one\n+ two\n+ three');
    expect(d.numericOnly).toBe(false);
  });

  it('treats an empty new text as everything removed', () => {
    const d = diffText('one\ntwo', '');
    expect(d.removed).toEqual(['one', 'two']);
    expect(d.added).toEqual([]);
    expect(d.unified).toBe('- one\n- two');
  });

  it('shows a single edit with one line of context and removals before additions', () => {
    const d = diffText('a\nb\nc\nd', 'a\nB\nc\nd');
    expect(d.removed).toEqual(['b']);
    expect(d.added).toEqual(['B']);
    expect(d.unified).toBe('  a\n- b\n+ B\n  c');
  });

  it('puts all "- " lines before "+ " lines within a multi-line edit', () => {
    const d = diffText('x\n1\n2\n3\ny', 'x\nA\nB\ny');
    expect(d.unified).toBe('  x\n- 1\n- 2\n- 3\n+ A\n+ B\n  y');
  });

  it('separates non-adjacent hunks with "…" and merges close ones', () => {
    const old = lines(10, (i) => `l${i}`);
    const far = [...old];
    far[1] = 'X1';
    far[8] = 'X8';
    expect(diffText(old.join('\n'), far.join('\n')).unified).toBe(
      ['  l0', '- l1', '+ X1', '  l2', '…', '  l7', '- l8', '+ X8', '  l9'].join('\n'),
    );

    const near = [...old];
    near[3] = 'X3';
    near[5] = 'X5';
    // one unchanged line (<= 2*context) between the edits → one hunk, no separator
    expect(diffText(old.join('\n'), near.join('\n')).unified).toBe(
      ['  l2', '- l3', '+ X3', '  l4', '- l5', '+ X5', '  l6'].join('\n'),
    );
  });

  it('does not add a separator before the first or after the last hunk', () => {
    const old = lines(20, (i) => `l${i}`);
    const neu = [...old];
    neu[10] = 'changed';
    const u = diffText(old.join('\n'), neu.join('\n')).unified;
    expect(u).toBe('  l9\n- l10\n+ changed\n  l11');
  });

  it('honours the context option', () => {
    const old = lines(10, (i) => `l${i}`);
    const neu = [...old];
    neu[5] = 'X';
    expect(diffText(old.join('\n'), neu.join('\n'), { context: 0 }).unified).toBe('- l5\n+ X');
    expect(diffText(old.join('\n'), neu.join('\n'), { context: 2 }).unified).toBe('  l3\n  l4\n- l5\n+ X\n  l6\n  l7');

    const two = [...old];
    two[2] = 'A';
    two[7] = 'B';
    expect(diffText(old.join('\n'), two.join('\n'), { context: 0 }).unified).toBe('- l2\n+ A\n…\n- l7\n+ B');
  });

  it('handles pure insertions and deletions in the middle', () => {
    const ins = diffText('a\nb\nc', 'a\nb\nNEW\nc');
    expect(ins.added).toEqual(['NEW']);
    expect(ins.removed).toEqual([]);
    expect(ins.unified).toBe('  b\n+ NEW\n  c');

    const del = diffText('a\nb\nOLD\nc', 'a\nb\nc');
    expect(del.removed).toEqual(['OLD']);
    expect(del.unified).toBe('  b\n- OLD\n  c');
  });

  it('handles reordered lines', () => {
    const d = diffText('a\nb\nc', 'c\na\nb');
    expect(d.added).toEqual(['c']);
    expect(d.removed).toEqual(['c']);
    expect(d.numericOnly).toBe(false);
    expectWellFormedUnified(d.unified);
    expect(d.unified).toBe('+ c\n  a\n  b\n- c');
  });

  it('keeps duplicate lines per the diff', () => {
    const d = diffText('x\ny', 'x\ndup\ndup\ny');
    expect(d.added).toEqual(['dup', 'dup']);
    const d2 = diffText('Buy\nBuy\nSell', 'Buy\nSell');
    expect(d2.removed).toEqual(['Buy']);
    expect(d2.added).toEqual([]);
  });

  it('flags number-only changes', () => {
    const d = diffText('Price\n$1,234.56\nUpdated 5 minutes ago', 'Price\n$1,301.02\nUpdated 1 hour ago');
    expect(d.numericOnly).toBe(true);
    expect(d.added).toEqual(['$1,301.02', 'Updated 1 hour ago']);
    expect(diffText('Price 5', 'Cost 5').numericOnly).toBe(false);
    expect(diffText('Price 5', 'Price 5').numericOnly).toBe(false);
  });

  it('numericOnly matches maskNumbers(old) === maskNumbers(new) && old !== new', () => {
    const pairs: Array<[string, string]> = [
      ['1\n2\n1', '2\n1\n2'], // values cycling: the line diff misaligns, masked texts are still equal
      ['a 1\nb 2', 'a 3\nb 4'],
      ['a 1', 'a 1\nb 2'],
      ['x\n5 minutes ago', 'x\n1 hour ago'],
      ['Total 5', 'Total 5 users'],
      ['one', 'two'],
      ['', '5'],
      ['same 1', 'same 1'],
    ];
    for (const [o, n] of pairs) {
      expect(diffText(o, n).numericOnly, `${JSON.stringify(o)} → ${JSON.stringify(n)}`).toBe(
        o !== n && maskNumbers(o) === maskNumbers(n),
      );
    }
    expect(diffText('1\n2\n1', '2\n1\n2').numericOnly).toBe(true);
  });

  it('maskNumbers is line-local', () => {
    const t = 'Updated 5\nminutes ago\n1\nitems\n-3';
    expect(maskNumbers(t)).toBe(t.split('\n').map(maskNumbers).join('\n'));
    expect(maskNumbers(t).split('\n')).toHaveLength(5);
  });

  it('ignores CRLF vs LF and a trailing newline', () => {
    const d = diffText('a\r\nb\r\n', 'a\nb');
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.unified).toBe('');
    expect(d.numericOnly).toBe(false);
  });

  it('truncates long lines to 180 chars plus an ellipsis without splitting surrogate pairs', () => {
    const long = 'x'.repeat(1000);
    const d = diffText('short', long);
    const plus = d.unified.split('\n').find((l) => l.startsWith('+ '))!;
    expect(plus).toBe('+ ' + 'x'.repeat(MAX_DIFF_LINE_CHARS) + '…');
    expect(d.added[0]).toBe(long); // added/removed keep the full line

    const emoji = 'y'.repeat(MAX_DIFF_LINE_CHARS - 1) + '😀'.repeat(10);
    const u = diffText('', emoji).unified;
    expect(u).toBe('+ ' + 'y'.repeat(MAX_DIFF_LINE_CHARS - 1) + '…');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(u)).toBe(false);
  });

  it('shows an edit late in a long line as a window around it (not two identical head-cut lines)', () => {
    const head = 'Liquidity risk: withdrawals from the protocol are processed through a queue that is managed by the redemption module, which batches requests and settles them on-chain once enough liquidity';
    const oldLine = `${head} is available; withdrawals may be delayed up to 7 days, but during stress they can take longer than that.`;
    const newLine = `${head} is available; withdrawals may be delayed up to 14 days, but during stress they can take longer than that.`;
    const d = diffText(`Risks\n${oldLine}`, `Risks\n${newLine}`);
    const minus = d.unified.split('\n').find((l) => l.startsWith('- '))!;
    const plus = d.unified.split('\n').find((l) => l.startsWith('+ '))!;
    expect(minus).not.toBe(plus.replace(/^\+/, '-'));
    expect(minus).toContain('7 days');
    expect(plus).toContain('14 days');
    expect(minus.startsWith('- …')).toBe(true);
    expect(plus.startsWith('+ …')).toBe(true);
    expect(minus.length).toBeLessThanOrEqual(2 + 1 + MAX_DIFF_LINE_CHARS + 1);
    expect(plus.length).toBeLessThanOrEqual(2 + 1 + MAX_DIFF_LINE_CHARS + 1);
    expect(d.added).toEqual([newLine]); // added/removed keep full lines
  });

  it('windows start at the line start for an early edit, and never split surrogate pairs', () => {
    const tail = ' and more text follows here'.repeat(10);
    const [a, b] = pairWindow(`Guardian multisig controls upgrades${tail}`, `Security Council controls upgrades${tail}`);
    expect(a.startsWith('Guardian multisig')).toBe(true);
    expect(b.startsWith('Security Council')).toBe(true);
    expect(a.endsWith('…')).toBe(true);

    const emoji = '😀'.repeat(150);
    const [x, y] = pairWindow(`${emoji} old ${emoji}`, `${emoji} new ${emoji}`);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lone.test(x)).toBe(false);
    expect(lone.test(y)).toBe(false);
    expect(x).toContain('old');
    expect(y).toContain('new');
    // Short lines are untouched.
    expect(pairWindow('a', 'b')).toEqual(['a', 'b']);
  });

  it('stops after maxLines and summarizes the rest', () => {
    const neu = lines(100, (i) => `new ${i}`);
    const d = diffText('', neu.join('\n'));
    const out = d.unified.split('\n');
    expect(out).toHaveLength(31);
    expect(out.slice(0, 30).every((l) => l.startsWith('+ '))).toBe(true);
    expect(out[30]).toBe('… (+70 more changed lines)');
    expect(d.added).toHaveLength(100);

    const small = diffText('', neu.join('\n'), { maxLines: 5 });
    expect(small.unified.split('\n')).toEqual(['+ new 0', '+ new 1', '+ new 2', '+ new 3', '+ new 4', '… (+95 more changed lines)']);

    expect(diffText('', 'a\nb', { maxLines: 0 }).unified).toBe('… (+2 more changed lines)');
  });

  it('does not add a summary line when everything fits', () => {
    const d = diffText('', lines(30).join('\n'));
    expect(d.unified.split('\n')).toHaveLength(30);
    expect(d.unified).not.toContain('more changed lines');
  });

  it('does not end a truncated diff with dangling context or separators', () => {
    const old = lines(200, (i) => `l${i}`);
    const neu = old.map((l, i) => (i % 10 === 5 ? `X${i}` : l));
    const u = diffText(old.join('\n'), neu.join('\n'), { maxLines: 12 }).unified.split('\n');
    expect(u.length).toBeLessThanOrEqual(13);
    expect(u[u.length - 1]).toMatch(/^… \(\+\d+ more changed lines\)$/);
    expect(u[u.length - 2]).toMatch(/^[+-] /);
  });

  it('shows both removed and added lines of a huge replacement even when truncated', () => {
    const old = lines(100, (i) => `old ${i}`);
    const neu = lines(100, (i) => `new ${i}`);
    const u = diffText(old.join('\n'), neu.join('\n')).unified.split('\n');
    expect(u.filter((l) => l.startsWith('- ')).length).toBe(15);
    expect(u.filter((l) => l.startsWith('+ ')).length).toBe(15);
    expect(u[u.length - 1]).toBe('… (+170 more changed lines)');
    // removals first
    expect(u.findIndex((l) => l.startsWith('+ '))).toBeGreaterThan(u.findLastIndex((l) => l.startsWith('- ')));
  });

  it('gives identical hashes for the same edit on different pages', () => {
    const a = diffText('Page A\nNav: Home Docs\nBody A', 'Page A\nNav: Home Docs Blog\nBody A');
    const b = diffText('Other page\nwith more\nNav: Home Docs\nfooter', 'Other page\nwith more\nNav: Home Docs Blog\nfooter');
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(sha1(JSON.stringify([['Nav: Home Docs'], ['Nav: Home Docs Blog']])));
    expect(diffText('x', 'y').hash).not.toBe(a.hash);
  });

  it('tolerates nullish inputs and bad options', () => {
    const d = diffText(undefined as unknown as string, 'a', { context: Number.NaN, maxLines: -5 });
    expect(d.added).toEqual(['a']);
    expect(d.unified).toBe('… (+1 more changed lines)');
    expect(diffText(null as unknown as string, null as unknown as string).unified).toBe('');
  });

  it('produces well-formed output on real page snapshots', () => {
    const home = readFileSync(new URL('./fixtures/nextjs-app-home.html', import.meta.url), 'utf8');
    const docs = readFileSync(new URL('./fixtures/nextjs-app-docs.html', import.meta.url), 'utf8');
    // Crude "text": strip tags; enough to exercise the diff on realistic, long, messy lines.
    const toText = (html: string) =>
      html
        .replace(/<script[\s\S]*?<\/script>/gi, '\n')
        .replace(/<[^>]+>/g, '\n')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join('\n');
    const d = diffText(toText(home), toText(docs));
    expectWellFormedUnified(d.unified);
    expect(d.unified.split('\n').length).toBeLessThanOrEqual(31);
    expect(d.added.length + d.removed.length).toBeGreaterThan(0);
  });

  describe('performance (10k-line documents)', () => {
    const base = lines(10_000, (i) => `Paragraph ${i}: lorem ipsum dolor sit amet, consectetur adipiscing elit`);

    const timed = (a: string[], b: string[]) => {
      const t = performance.now();
      const d = diffText(a.join('\n'), b.join('\n'));
      const ms = performance.now() - t;
      expectWellFormedUnified(d.unified);
      return { d, ms };
    };

    it('few scattered edits', () => {
      const b = [...base];
      b[10] = 'edited 10';
      b[5000] = 'edited 5000';
      b.splice(9000, 0, 'inserted');
      const { d, ms } = timed(base, b);
      expect(ms).toBeLessThan(500);
      expect(d.added).toEqual(['edited 10', 'edited 5000', 'inserted']);
      expect(d.removed).toEqual([base[10], base[5000]]);
    });

    it('many scattered edits (every 3rd line)', () => {
      const b = base.map((l, i) => (i % 3 === 0 ? l + ' (edited)' : l));
      const { d, ms } = timed(base, b);
      expect(ms).toBeLessThan(500);
      expect(d.added).toHaveLength(3334);
      expect(d.removed).toHaveLength(3334);
    });

    it('completely different documents', () => {
      const b = base.map((l) => l.toUpperCase());
      const { d, ms } = timed(base, b);
      expect(ms).toBeLessThan(500);
      expect(d.added).toHaveLength(10_000);
      expect(d.removed).toHaveLength(10_000);
      expect(d.unified).toContain('more changed lines');
    });

    it('heavily reordered document', () => {
      // deterministic shuffle
      const b = [...base];
      let seed = 42;
      for (let i = b.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const j = seed % (i + 1);
        [b[i], b[j]] = [b[j], b[i]];
      }
      const { d, ms } = timed(base, b);
      expect(ms).toBeLessThan(500);
      // every reported edit is a real line from the respective side
      const baseSet = new Set(base);
      expect(d.removed.every((l) => baseSet.has(l))).toBe(true);
      expect(d.added.every((l) => baseSet.has(l))).toBe(true);
    });

    it('large block moved', () => {
      const b = [...base.slice(5000), ...base.slice(0, 5000)];
      const { ms, d } = timed(base, b);
      expect(ms).toBeLessThan(500);
      expect(d.added.length + d.removed.length).toBeGreaterThan(0);
    });

    it('everything added to an empty document', () => {
      const { d, ms } = timed([], base);
      expect(ms).toBeLessThan(500);
      expect(d.added).toHaveLength(10_000);
    });

    it('very long lines', () => {
      const a = lines(2000, (i) => `${i} ` + 'z'.repeat(5000));
      const b = a.map((l, i) => (i % 100 === 0 ? l + '!' : l));
      const { d, ms } = timed(a, b);
      expect(ms).toBeLessThan(500);
      expect(d.added).toHaveLength(20);
      for (const l of d.unified.split('\n')) expect(l.length).toBeLessThanOrEqual(MAX_DIFF_LINE_CHARS + 3);
    });
  });
});
