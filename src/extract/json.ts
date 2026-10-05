/**
 * JSON API responses as diffable "pages": a canonical, key-sorted, pretty-printed rendering so an API change shows up
 * as a readable line diff (`- "count": 705` / `+ "count": 706`) through the same pipeline as visible page text.
 */

import type { ParsedPage } from './html.js';

/** Lines kept from one JSON document (bigger documents are cut, with a note). */
export const MAX_JSON_LINES = 4000;

/** Response looks like JSON: a JSON content type, or an untyped / text body that starts like JSON. */
export function looksLikeJson(contentType: string | null, bodyText: string | null): boolean {
  if (typeof bodyText !== 'string') return false;
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json')) return true;
  if (ct && ct !== 'text/plain' && ct !== 'application/octet-stream') return false;
  const head = bodyText.replace(/^﻿/, '').trimStart();
  return head.startsWith('{') || head.startsWith('[');
}

function sortKeys(v: unknown, depth = 0): unknown {
  if (depth > 64 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => sortKeys(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k], depth + 1);
  return out;
}

/** Canonical lines of a JSON document, or null if it doesn't parse. */
export function jsonLines(bodyText: string): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(bodyText.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  const lines = JSON.stringify(sortKeys(value), null, 2).split('\n');
  if (lines.length <= MAX_JSON_LINES) return lines;
  return [...lines.slice(0, MAX_JSON_LINES), `… (${lines.length - MAX_JSON_LINES} more lines not compared)`];
}

const HOST_RE = /\b(?:https?|wss?):\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/gi;

/** A JSON response shaped like a parsed HTML page (no title/links), or null if the body isn't valid JSON. */
export function jsonAsPage(bodyText: string): ParsedPage | null {
  const lines = jsonLines(bodyText);
  if (!lines) return null;
  const hosts = new Set<string>();
  for (const m of bodyText.slice(0, 2_000_000).matchAll(HOST_RE)) {
    hosts.add(m[1].toLowerCase());
    if (hosts.size >= 200) break;
  }
  return {
    title: null,
    description: null,
    ogImage: null,
    canonical: null,
    generator: null,
    textLines: lines,
    links: [],
    assets: { scripts: [], styles: [], preloads: [] },
    buildId: null,
    hosts: [...hosts],
    noindex: false,
  };
}
