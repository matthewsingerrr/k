/**
 * Text helpers for the pages checker: snapshots, compare hashes, readable diffs, grouping and info messages.
 * Pure functions; none of them throw for string input.
 */

import { MAX_STORED_TEXT_CHARS } from '../db/store.js';
import { pageTextSnapshot, type ParsedPage } from '../extract/html.js';
import { displayUrl, urlPath } from '../extract/url.js';
import { applyIgnorePatterns, compareText, diffText, maskNumbers, normalizeRelativeTimes, sha1 } from '../diff/text.js';
import type { InfoAlert, TextAlert, TextChange, TextDiff, Watch } from '../types.js';

/** Settings that decide what counts as a text change on one page. */
export interface CompareSettings {
  ignorePatterns: string[];
  maskNumbers: boolean;
  /** Masked forms of lines whose numbers tick: digits ignored on those lines only. */
  maskedLines?: ReadonlySet<string>;
}

/**
 * Canonical text snapshot of a parsed page, capped exactly like the store caps page text so the hash of what we store
 * and the hash of what we fetch always describe the same characters.
 */
export function snapshotOf(parsed: ParsedPage): string {
  return capText(pageTextSnapshot(parsed), MAX_STORED_TEXT_CHARS);
}

function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** Compare text + its sha1 for a snapshot under the given settings. */
export function compareHash(snapshot: string, s: CompareSettings): { cmp: string; hash: string } {
  const cmp = compareText(snapshot, { ignorePatterns: s.ignorePatterns, maskNumbers: s.maskNumbers, maskedLines: s.maskedLines });
  return { cmp, hash: sha1(cmp) };
}

/** Masked forms of the lines that differ between two texts only in their numbers (line-aligned; [] if the shapes differ). */
export function tickingLines(a: string, b: string): string[] {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length !== y.length) return [];
  const out = new Set<string>();
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    const m = maskNumbers(x[i]);
    if (m === maskNumbers(y[i])) out.add(m);
  }
  return [...out];
}

/**
 * For display only: when numbers are masked on a page, the stored text can hold numbers from long ago (unchanged-looking
 * fetches never rewrite it). Swap each old line that has a number-only counterpart in the new text for that counterpart,
 * so the diff shows the real edit instead of every ticker line that drifted since the last stored version.
 */
export function alignNumbers(
  oldText: string,
  newText: string,
  only?: (maskedLine: string) => boolean,
  key: (line: string) => string = maskNumbers,
): string {
  if (!oldText || !newText) return oldText;
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const byMask = new Map<string, { lines: string[]; next: number }>();
  for (const line of newLines) {
    if (oldSet.has(line)) continue;
    const m = key(line);
    if (m === line || (only && !only(m))) continue;
    const slot = byMask.get(m);
    if (slot) slot.lines.push(line);
    else byMask.set(m, { lines: [line], next: 0 });
  }
  if (byMask.size === 0) return oldText;
  let changed = false;
  const out = oldLines.map((line) => {
    if (newSet.has(line)) return line;
    const m = key(line);
    if (m === line) return line;
    const slot = byMask.get(m);
    if (!slot || slot.next >= slot.lines.length) return line;
    changed = true;
    return slot.lines[slot.next++];
  });
  return changed ? out.join('\n') : oldText;
}

/**
 * Diff for a confirmed change. Ignored parts are removed from both sides first (they are, by definition, not changes the
 * user wants to see, and keeping them would give identical site-wide edits different hashes), and with number masking on
 * the old side is re-aligned to current numbers.
 */
export function pageDiff(oldSnapshot: string, newSnapshot: string, s: CompareSettings): TextDiff {
  const newText = applyIgnorePatterns(newSnapshot, s.ignorePatterns);
  let oldText = applyIgnorePatterns(oldSnapshot, s.ignorePatterns);
  // Relative times ("2 seconds ago") are never changes: show their current value on both sides.
  oldText = alignNumbers(oldText, newText, undefined, normalizeRelativeTimes);
  if (s.maskNumbers) oldText = alignNumbers(oldText, newText);
  else if (s.maskedLines && s.maskedLines.size > 0) {
    const lines = s.maskedLines;
    oldText = alignNumbers(oldText, newText, (m) => lines.has(m));
  }
  return diffText(oldText, newText);
}

/** Title change worth reporting (ignoring what the compare settings ignore), or null. */
export function titleChange(
  from: string | null,
  to: string | null,
  s: CompareSettings,
): { from: string | null; to: string | null } | null {
  if ((from ?? '') === (to ?? '')) return null;
  if (compareText(from ?? '', s) === compareText(to ?? '', s)) return null;
  return { from, to };
}

/** Group changes by identical diff (a site-wide nav edit shows once); largest group first, ties in first-seen order. */
export function groupChanges(changes: TextChange[]): TextAlert['groups'] {
  const groups = new Map<string, { hash: string; urls: string[]; diff: TextDiff; order: number }>();
  for (const c of changes) {
    const g = groups.get(c.diff.hash);
    if (g) g.urls.push(c.url);
    else groups.set(c.diff.hash, { hash: c.diff.hash, urls: [c.url], diff: c.diff, order: groups.size });
  }
  return [...groups.values()]
    .sort((a, b) => b.urls.length - a.urls.length || a.order - b.order)
    .map(({ hash, urls, diff }) => ({ hash, urls, diff }));
}

/** Short label for a page in messages: its path when on the watched host, else host + path. */
export function pageLabel(url: string, watch: Pick<Watch, 'url'>): string {
  try {
    const u = new URL(url);
    const w = new URL(watch.url);
    if (u.host === w.host) return urlPath(url);
  } catch {
    // fall through
  }
  return displayUrl(url);
}

export function dynamicInfo(label: string): InfoAlert {
  return {
    kind: 'info',
    message: `ℹ️ ${label} changes on every load; ignoring its text. Use /watch ignore to filter the changing part.`,
  };
}

export function liveNumbersInfo(label: string): InfoAlert {
  return {
    kind: 'info',
    message: `ℹ️ ${label} shows live numbers; ignoring number-only changes on the lines that tick.`,
  };
}

export function churnInfo(label: string): InfoAlert {
  return {
    kind: 'info',
    message: `ℹ️ ${label} changes too often; ignoring its text until it settles down. Use /watch ignore to filter the changing part.`,
  };
}

/** Why a page's text is (partly) ignored from now on. */
export type NoiseKind = 'live' | 'dynamic' | 'churn';

const NOISE_LABELS_LISTED = 10;

function labelList(labels: string[]): string {
  const shown = labels.slice(0, NOISE_LABELS_LISTED);
  const rest = labels.length - shown.length;
  return shown.join(', ') + (rest > 0 ? ` and ${rest} more` : '');
}

/**
 * One info alert for every page that became noisy in one pass (a site-wide ticker can hit dozens of pages at once, and
 * one message per page would be its own kind of noise). A single page keeps its specific message.
 */
export function noiseInfo(items: Array<{ kind: NoiseKind; label: string }>): InfoAlert | null {
  const seen = new Set<string>();
  const list = items.filter((i) => {
    const key = `${i.kind}\u0000${i.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (list.length === 0) return null;
  if (list.length === 1) {
    const { kind, label } = list[0];
    return kind === 'live' ? liveNumbersInfo(label) : kind === 'churn' ? churnInfo(label) : dynamicInfo(label);
  }
  const by = (k: NoiseKind) => list.filter((i) => i.kind === k).map((i) => i.label);
  const live = by('live');
  const dynamic = by('dynamic');
  const churn = by('churn');
  const parts: string[] = [];
  if (live.length) parts.push(`number-only changes on the ticking lines of ${live.length === 1 ? '1 page' : `${live.length} pages`} that show live numbers: ${labelList(live)}`);
  if (dynamic.length) parts.push(`the text of ${dynamic.length === 1 ? '1 page' : `${dynamic.length} pages`} that change on every load: ${labelList(dynamic)}`);
  if (churn.length) parts.push(`the text of ${churn.length === 1 ? '1 page' : `${churn.length} pages`} that change too often: ${labelList(churn)}`);
  const tail = dynamic.length || churn.length ? ' Use /watch ignore to filter the changing part.' : '';
  if (parts.length === 1) return { kind: 'info', message: `ℹ️ Ignoring ${parts[0]}.${tail}` };
  return { kind: 'info', message: `ℹ️ Ignoring noisy text on ${list.length} pages:\n${parts.map((p) => `• ${p}`).join('\n')}${tail ? `\n${tail.trim()}` : ''}` };
}
