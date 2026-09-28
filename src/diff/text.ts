/**
 * Text comparison helpers: hashing, number masking, ignore patterns and a readable line diff.
 *
 * The line diff is built for "what changed on this page" alerts rendered in a Discord ```diff block:
 * - common prefix/suffix are trimmed first and lines that exist on only one side are taken out of the LCS problem
 *   (they are certainly edits), so jsdiff's Myers only runs on lines present in both texts — typical page edits
 *   diff in well under a millisecond even for 10k-line documents;
 * - the remaining Myers run is bounded (edit-length budget); when exceeded we fall back to a multiset diff, so a
 *   pathological page can never stall the process.
 */

import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { diffArrays, type ArrayChange } from 'diff';
import type { TextDiff } from '../types.js';

/** Max chars of a line in `unified` before it is cut (an ellipsis is appended). */
export const MAX_DIFF_LINE_CHARS = 180;
const DEFAULT_CONTEXT = 1;
const DEFAULT_MAX_LINES = 30;
/** Rough work budget for the Myers pass: (n + m) * maxEditLength. ~20M keeps the worst case well under 100ms. */
const MYERS_BUDGET = 20_000_000;

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** sha1 hex of a string (utf-8) or Buffer. */
export function sha1(input: string | Buffer): string {
  const h = createHash('sha1');
  if (typeof input === 'string') h.update(input, 'utf8');
  else if (input instanceof Uint8Array) h.update(input);
  else h.update(String(input ?? ''), 'utf8');
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Number masking
// ---------------------------------------------------------------------------

const REL_UNIT =
  String.raw`(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|mths?|months?|y|yrs?|years?)`;
/** Horizontal whitespace only: masking must stay line-local (see numericOnly in diffText). */
const WS = String.raw`[^\S\n]`;
const REL_WORD_QTY = String.raw`(?:an?|one|a${WS}+few|a${WS}+couple(?:${WS}+of)?|few|several|some)`;
const NUM = String.raw`\p{Nd}+(?:[.,]\p{Nd}+)*`;

/**
 * Relative-time phrases ("5 minutes ago", "an hour ago", "3h ago", "just now") → "# ago", so "59 minutes ago" and
 * "1 hour ago" compare equal after masking.
 */
const RELATIVE_TIME_RE = new RegExp(
  String.raw`(?:\b${REL_WORD_QTY}${WS}+|${NUM}${WS}*)${REL_UNIT}\.?${WS}+ago\b|\bjust${WS}+now\b|\b(?:a${WS}+)?moments?${WS}+ago\b`,
  'giu',
);

/**
 * A number: digit groups joined by single "," or "." ("1,234.56", "1.2.3", "2026" of a date), optionally with a leading
 * sign ("+3.2", "-0.5", "−4") — but only when the sign is not glued to a preceding word/number, so "2026-09-28" masks
 * to "#-#-#" and "a-5" keeps its hyphen.
 */
const NUMBER_RE = /(?:(?<![\p{L}\p{N}_)\]])[+\-−±])?\p{Nd}+(?:[.,]\p{Nd}+)*/gu;

/** "# items" / "# item", "# minutes" / "# minute": a count changing between 1 and N must not look like a text change. */
const COUNT_PLURAL_RE = /(#[^\S\n]*)(\p{L}{2,}?)(?:s|\(s\))(?![\p{L}\p{N}_])/giu;

/**
 * Replace every run of digits (optionally with , . separators between digit groups, e.g. "1,234.56") with "#".
 * Also mask a leading +/- sign attached to a number and common relative-time phrases' numbers ("5 minutes ago" → "# minutes ago").
 *
 * Examples: "$12.5M" → "$#M", "+3.2%" → "#%", "v1.2.3" → "v#", "2026-09-28" → "#-#-#", "14:43" → "#:#",
 * "5 minutes ago" / "an hour ago" → "# ago". Only meant for equality comparison, never for display.
 * Line-local: no replacement spans a "\n", so maskNumbers(text) === lines.map(maskNumbers).join("\n").
 */
export function maskNumbers(s: string): string {
  if (typeof s !== 'string') s = String(s ?? '');
  if (s === '') return s;
  return s.replace(RELATIVE_TIME_RE, '# ago').replace(NUMBER_RE, '#').replace(COUNT_PLURAL_RE, '$1$2');
}

/**
 * Relative-time phrases only ("59 minutes ago", "an hour ago", "2h ago", "just now" → "# ago"). They drift on their own
 * as the clock moves, so they are never a content change; unlike maskNumbers every other number is kept.
 */
export function normalizeRelativeTimes(s: string): string {
  if (typeof s !== 'string') s = String(s ?? '');
  if (s === '') return s;
  return s.replace(RELATIVE_TIME_RE, '# ago');
}

// ---------------------------------------------------------------------------
// Ignore patterns
// ---------------------------------------------------------------------------

/** A user ignore pattern ran too long on one page's text (catastrophic backtracking); the page is skipped this time. */
export class PatternTimeoutError extends Error {
  constructor(message = 'ignore patterns too slow on this page') {
    super(message);
    this.name = 'PatternTimeoutError';
  }
}

/** Wall-clock limit for applying every ignore pattern to one text. Sane patterns need a few ms even on huge pages. */
export const IGNORE_PATTERN_TIMEOUT_MS = 1000;
const PATTERN_CACHE_MAX = 1000;

/**
 * User regexes run inside one reused vm context: only the vm watchdog can interrupt a runaway (catastrophically
 * backtracking) regex, which would otherwise freeze the whole process — every watch, the Discord connection and /health.
 * Compiled patterns are cached inside the context (keyed by source); invalid sources compile to null and are skipped.
 */
let ignoreContext: vm.Context | null = null;
const IGNORE_SCRIPT = new vm.Script(`(() => {
  const input = globalThis.__in;
  const res = [];
  for (const src of input.sources) {
    let re = __cache.get(src);
    if (re === undefined) {
      try { re = new RegExp(src, 'gi'); } catch (e) { re = null; }
      if (__cache.size >= ${PATTERN_CACHE_MAX}) __cache.clear();
      __cache.set(src, re);
    }
    if (re) res.push(re);
  }
  if (res.length === 0) return null;
  const lines = input.lines;
  const out = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    for (const re of res) { re.lastIndex = 0; line = line.replace(re, ''); }
    out[i] = line;
  }
  return out;
})()`);

function runIgnoreScript(lines: string[], sources: string[]): string[] | null {
  if (!ignoreContext) {
    ignoreContext = vm.createContext({});
    vm.runInContext('globalThis.__cache = new Map();', ignoreContext);
  }
  const ctx = ignoreContext as Record<string, unknown>;
  ctx.__in = { lines, sources };
  try {
    const out = IGNORE_SCRIPT.runInContext(ignoreContext, { timeout: IGNORE_PATTERN_TIMEOUT_MS }) as unknown;
    if (out === null || out === undefined) return null;
    return Array.from(out as ArrayLike<unknown>, (v) => (typeof v === 'string' ? v : String(v ?? '')));
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new PatternTimeoutError();
    throw err;
  } finally {
    ctx.__in = undefined;
  }
}

function patternSources(patterns: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(patterns)) return [];
  return patterns.filter((p): p is string => typeof p === 'string' && p !== '');
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Apply ignore patterns: each pattern is a JS regex source compiled with flags "gi"; every match is replaced by "" line-by-line,
 * then whitespace collapsed, and lines that become empty are removed. Invalid regex sources are skipped silently.
 *
 * Whitespace is always normalized (also without patterns) and blank lines are always dropped: whitespace-only edits are
 * not visible-text changes. Patterns see the whitespace-collapsed line, so a pattern written with single spaces matches.
 *
 * The patterns run under a time limit (IGNORE_PATTERN_TIMEOUT_MS for the whole text): a pattern that backtracks
 * catastrophically on some page throws PatternTimeoutError instead of stalling the process.
 */
export function applyIgnorePatterns(text: string, patterns: string[]): string {
  const src = typeof text === 'string' ? text : String(text ?? '');
  if (src === '') return '';
  const lines: string[] = [];
  for (const raw of src.split('\n')) {
    const line = collapseWs(raw);
    if (line !== '') lines.push(line);
  }
  const sources = patternSources(patterns);
  if (sources.length === 0 || lines.length === 0) return lines.join('\n');
  const replaced = runIgnoreScript(lines, sources);
  if (!replaced) return lines.join('\n');
  const out: string[] = [];
  for (const raw of replaced) {
    const line = collapseWs(raw);
    if (line !== '') out.push(line);
  }
  return out.join('\n');
}

/**
 * Text actually hashed for change detection: applyIgnorePatterns, then maskNumbers if `mask` (or only on lines whose masked
 * form is in `maskedLines`) — and relative-time phrases ("5 minutes ago") are always normalized, since they drift with the
 * clock without the page changing.
 */
export function compareText(
  text: string,
  opts: { ignorePatterns: string[]; maskNumbers: boolean; maskedLines?: ReadonlySet<string> },
): string {
  const cleaned = applyIgnorePatterns(text, opts?.ignorePatterns ?? []);
  if (opts?.maskNumbers) return maskNumbers(cleaned);
  const lines = opts?.maskedLines;
  if (lines && lines.size > 0 && cleaned) {
    // Digits are ignored only on lines known to tick (their masked form was learned); every other number still counts.
    return cleaned
      .split('\n')
      .map((l) => {
        const m = maskNumbers(l);
        return lines.has(m) ? m : normalizeRelativeTimes(l);
      })
      .join('\n');
  }
  return normalizeRelativeTimes(cleaned);
}

// ---------------------------------------------------------------------------
// Line diff
// ---------------------------------------------------------------------------

/** Unchanged lines old[a0, a1) (== new[b0, b0 + (a1 - a0))). */
interface EqRun {
  eq: true;
  a0: number;
  a1: number;
}
/** A contiguous edit: `del` lines removed from old, `ins` lines inserted in new. */
interface ChangeRun {
  eq: false;
  del: string[];
  ins: string[];
}
type Run = EqRun | ChangeRun;

function toText(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Split into lines ("\n" or "\r\n"); "" has no lines and a single trailing newline does not add an empty line. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/** Multiset difference a − b (order of `a` kept). */
function multisetMinus(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const s of b) counts.set(s, (counts.get(s) ?? 0) + 1);
  const out: string[] = [];
  for (const s of a) {
    const c = counts.get(s);
    if (c) counts.set(s, c - 1);
    else out.push(s);
  }
  return out;
}

/**
 * Minimal-ish edit script as alternating equal / change runs.
 * Exact LCS (via Myers) unless the edit budget is exceeded; then the middle becomes one change run holding the
 * multiset difference (moved lines are not reported).
 */
function diffRuns(a: string[], b: string[]): Run[] {
  const runs: Run[] = [];
  const pushEq = (a0: number, a1: number): void => {
    if (a1 <= a0) return;
    const last = runs[runs.length - 1];
    if (last && last.eq && last.a1 === a0) last.a1 = a1;
    else runs.push({ eq: true, a0, a1 });
  };
  const pushChange = (del: string[], ins: string[]): void => {
    if (del.length === 0 && ins.length === 0) return;
    const last = runs[runs.length - 1];
    if (last && !last.eq) {
      for (const s of del) last.del.push(s);
      for (const s of ins) last.ins.push(s);
    } else runs.push({ eq: false, del, ins });
  };

  const n = a.length;
  const m = b.length;
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const aEnd = n - suf;
  const bEnd = m - suf;

  pushEq(0, pre);

  if (aEnd - pre === 0 || bEnd - pre === 0) {
    pushChange(a.slice(pre, aEnd), b.slice(pre, bEnd));
  } else {
    // Intern lines and keep only those present on both sides: others can never be part of the LCS.
    const ids = new Map<string, number>();
    const idOf = (s: string): number => {
      let id = ids.get(s);
      if (id === undefined) {
        id = ids.size;
        ids.set(s, id);
      }
      return id;
    };
    const aIds = new Int32Array(aEnd - pre);
    for (let i = pre; i < aEnd; i++) aIds[i - pre] = idOf(a[i]);
    const inA = new Uint8Array(ids.size + (bEnd - pre));
    for (let i = 0; i < aIds.length; i++) inA[aIds[i]] = 1;
    const bIds = new Int32Array(bEnd - pre);
    for (let j = pre; j < bEnd; j++) bIds[j - pre] = idOf(b[j]);
    const inB = new Uint8Array(ids.size);
    for (let j = 0; j < bIds.length; j++) inB[bIds[j]] = 1;

    const aKeep: number[] = []; // absolute indices into a
    const aVals: number[] = [];
    for (let i = 0; i < aIds.length; i++) {
      if (inB[aIds[i]]) {
        aKeep.push(pre + i);
        aVals.push(aIds[i]);
      }
    }
    const bKeep: number[] = [];
    const bVals: number[] = [];
    for (let j = 0; j < bIds.length; j++) {
      if (inA[bIds[j]]) {
        bKeep.push(pre + j);
        bVals.push(bIds[j]);
      }
    }

    let parts: ArrayChange<number>[] | undefined;
    if (aVals.length === 0 || bVals.length === 0) {
      parts = [];
    } else {
      const maxEditLength = Math.max(64, Math.floor(MYERS_BUDGET / (aVals.length + bVals.length)));
      try {
        parts = diffArrays(aVals, bVals, { maxEditLength });
      } catch {
        parts = undefined;
      }
    }

    if (!parts) {
      const del = a.slice(pre, aEnd);
      const ins = b.slice(pre, bEnd);
      const d = multisetMinus(del, ins);
      const s = multisetMinus(ins, del);
      // A pure reordering has an empty multiset difference; show it as a full replacement instead of "no change".
      if (d.length === 0 && s.length === 0) pushChange(del, ins);
      else pushChange(d, s);
    } else {
      let pa = pre; // next unconsumed absolute index in a
      let pb = pre;
      let ka = 0; // position in aKeep
      let kb = 0;
      for (const part of parts) {
        const count = part.count ?? part.value.length;
        if (part.added) kb += count;
        else if (part.removed) ka += count;
        else {
          for (let k = 0; k < count; k++) {
            const ai = aKeep[ka + k];
            const bi = bKeep[kb + k];
            if (ai > pa || bi > pb) pushChange(a.slice(pa, ai), b.slice(pb, bi));
            pushEq(ai, ai + 1);
            pa = ai + 1;
            pb = bi + 1;
          }
          ka += count;
          kb += count;
        }
      }
      pushChange(a.slice(pa, aEnd), b.slice(pb, bEnd));
    }
  }

  pushEq(aEnd, n);
  return runs;
}

function truncateLine(s: string): string {
  if (s.length <= MAX_DIFF_LINE_CHARS) return s;
  let cut = s.slice(0, MAX_DIFF_LINE_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // don't split a surrogate pair
  return cut + '…';
}

/** Chars of unchanged text kept around the edit in a windowed diff line. */
const WINDOW_CONTEXT = 40;
/** How far a window start may move back to begin at a word boundary. */
const WINDOW_SNAP = 15;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Move `i` back by one if it would split a surrogate pair (s[i] is the low half). */
function safeCut(s: string, i: number): number {
  return i > 0 && i < s.length && isLowSurrogate(s.charCodeAt(i)) && isHighSurrogate(s.charCodeAt(i - 1)) ? i - 1 : i;
}

/**
 * Render a changed line pair so the edit is visible: when either line is too long to show whole, both are cut to a window
 * around the first difference (same start offset on both sides), so an edit late in a long paragraph does not render as
 * two identical head-cut lines. Short lines are returned unchanged.
 */
export function pairWindow(oldLine: string, newLine: string): [string, string] {
  const max = MAX_DIFF_LINE_CHARS;
  if (oldLine.length <= max && newLine.length <= max) return [oldLine, newLine];
  const minLen = Math.min(oldLine.length, newLine.length);
  let p = 0;
  while (p < minLen && oldLine.charCodeAt(p) === newLine.charCodeAt(p)) p++;
  let suf = 0;
  while (suf < minLen - p && oldLine.charCodeAt(oldLine.length - 1 - suf) === newLine.charCodeAt(newLine.length - 1 - suf)) suf++;

  let start = p > WINDOW_CONTEXT ? p - WINDOW_CONTEXT : 0;
  if (start > 0) {
    const space = oldLine.lastIndexOf(' ', start);
    if (space >= 0 && start - space <= WINDOW_SNAP) start = space + 1;
  }
  start = safeCut(oldLine, start);
  const cut = (line: string): string => {
    let end = Math.min(line.length, Math.max(line.length - suf + WINDOW_CONTEXT, p + WINDOW_CONTEXT));
    end = Math.min(end, start + max);
    end = safeCut(line, end);
    return (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '');
  };
  return [cut(oldLine), cut(newLine)];
}

const CTX = 0;
const SEP = 1;
const CHG = 2;

function renderUnified(runs: Run[], a: string[], context: number, maxLines: number, totalChanged: number): string {
  if (totalChanged === 0) return '';
  const out: string[] = [];
  const kinds: number[] = [];
  let shown = 0;
  let full = false;

  const emit = (kind: number, text: string): boolean => {
    if (out.length >= maxLines) {
      full = true;
      return false;
    }
    out.push(text);
    kinds.push(kind);
    return true;
  };
  const emitCtx = (from: number, to: number): void => {
    for (let i = from; i < to && !full; i++) emit(CTX, '  ' + truncateLine(a[i]));
  };

  for (let r = 0; r < runs.length && !full; r++) {
    const run = runs[r];
    if (run.eq) {
      const len = run.a1 - run.a0;
      const hasPrev = r > 0;
      const hasNext = r < runs.length - 1;
      if (hasPrev && hasNext && len <= 2 * context) {
        emitCtx(run.a0, run.a1);
      } else {
        if (hasPrev) emitCtx(run.a0, run.a0 + Math.min(context, len));
        if (hasNext) {
          if (hasPrev) emit(SEP, '…');
          emitCtx(run.a1 - Math.min(context, len), run.a1);
        }
      }
      continue;
    }

    const room = maxLines - out.length;
    let delShow = run.del.length;
    let insShow = run.ins.length;
    if (delShow + insShow > room) {
      // Share the remaining room so a big removal can't hide every added line (and vice versa).
      if (run.ins.length === 0) delShow = Math.max(0, room);
      else if (run.del.length === 0) insShow = Math.max(0, room);
      else {
        delShow = Math.min(run.del.length, Math.max(Math.ceil(room / 2), room - run.ins.length));
        insShow = Math.min(run.ins.length, room - delShow);
      }
      full = true;
    }
    // Paired lines (k-th removed ↔ k-th added) are windowed around their edit; the rest are head-cut.
    const pairs = Math.min(delShow, insShow);
    const windowed = new Map<number, [string, string]>();
    for (let k = 0; k < pairs; k++) windowed.set(k, pairWindow(run.del[k], run.ins[k]));
    for (let i = 0; i < delShow; i++) {
      out.push('- ' + (windowed.get(i)?.[0] ?? truncateLine(run.del[i])));
      kinds.push(CHG);
    }
    for (let i = 0; i < insShow; i++) {
      out.push('+ ' + (windowed.get(i)?.[1] ?? truncateLine(run.ins[i])));
      kinds.push(CHG);
    }
    shown += delShow + insShow;
  }

  const remaining = totalChanged - shown;
  if (remaining > 0) {
    // Drop dangling context/separators that lead into changes we are not showing.
    while (kinds.length > 0 && kinds[kinds.length - 1] !== CHG) {
      kinds.pop();
      out.pop();
    }
    out.push(`… (+${remaining} more changed lines)`);
  }
  return out.join('\n');
}

/**
 * Line diff of two texts (split on "\n").
 * - added / removed: lines only in new / only in old (in order, duplicates kept per the diff).
 * - numericOnly: maskNumbers(oldText) === maskNumbers(newText) && oldText !== newText.
 * - unified: build hunks from the line diff; each changed line prefixed "- " (old) or "+ " (new), `context` (default 1) unchanged
 *   lines around each change prefixed "  "; separate non-adjacent hunks with a line "…". Truncate each line to 180 chars (append "…"),
 *   stop after `maxLines` (default 30) lines and append "… (+N more changed lines)" if more changes exist.
 * - hash: sha1 of JSON.stringify([removed, added]).
 *
 * "\r\n" is treated like "\n" and a trailing newline is ignored. Within each contiguous edit all "- " lines come before
 * the "+ " lines. Never throws for string input; bounded time for any input size.
 */
export function diffText(oldText: string, newText: string, opts?: { context?: number; maxLines?: number }): TextDiff {
  const context = clampInt(opts?.context, DEFAULT_CONTEXT, 0, 1000);
  const maxLines = clampInt(opts?.maxLines, DEFAULT_MAX_LINES, 0, 100_000);
  const a = splitLines(toText(oldText));
  const b = splitLines(toText(newText));

  const runs = diffRuns(a, b);
  const removed: string[] = [];
  const added: string[] = [];
  for (const run of runs) {
    if (run.eq) continue;
    for (const s of run.del) removed.push(s);
    for (const s of run.ins) added.push(s);
  }

  // Masking is line-local, so maskNumbers(old) === maskNumbers(new) ⇔ same line count and every differing line pair
  // masks equal. Only differing lines are masked, and the first mismatch ends the check.
  let differs = false;
  let numericOnly = a.length === b.length;
  for (let i = 0; numericOnly && i < a.length; i++) {
    if (a[i] === b[i]) continue;
    differs = true;
    numericOnly = maskNumbers(a[i]) === maskNumbers(b[i]);
  }
  numericOnly = numericOnly && differs;

  return {
    added,
    removed,
    numericOnly,
    unified: renderUnified(runs, a, context, maxLines, removed.length + added.length),
    hash: sha1(JSON.stringify([removed, added])),
  };
}
