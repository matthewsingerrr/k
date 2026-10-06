import type { Logger } from './types.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

/** Whitespace, C0/C1 controls, DEL and line/paragraph separators: anything that could split or forge a log line. */
const UNSAFE_CHARS = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const RAW_IN_JSON = /[\u007f-\u009f\u2028\u2029]/g;

/** JSON.stringify leaves DEL, C1 controls and U+2028/9 raw: escape them too. */
function escapeRest(json: string): string {
  return json.replace(RAW_IN_JSON, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** JSON-quoted with every unsafe character escaped. */
function quote(s: string): string {
  return escapeRest(JSON.stringify(s));
}

/** Unsafe characters other than the plain space (messages and error texts are normally prose). */
function hasUnsafe(s: string): boolean {
  return UNSAFE_CHARS.test(s.replace(/ /g, ''));
}

/** Messages are fixed strings, but some interpolate data: keep each record on one line. */
function oneLine(msg: string): string {
  return hasUnsafe(msg) ? quote(msg).slice(1, -1) : msg;
}

function fmtMeta(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    let s: string;
    if (v instanceof Error) {
      // Stacks are multi-line by design; an error *message* carrying line breaks or escapes (text from a website or a
      // client) is quoted instead, so it can't forge log records.
      s = hasUnsafe(String(v.message)) ? quote(v.stack ?? v.message) : (v.stack ?? v.message);
    } else if (typeof v === 'string') s = UNSAFE_CHARS.test(v) ? quote(v) : v;
    else {
      try {
        s = escapeRest(JSON.stringify(v) ?? String(v));
      } catch {
        s = quote(String(v));
      }
    }
    parts.push(`${k}=${s}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

/** Minimal leveled logger writing single-line records to stdout/stderr (Railway captures both). */
export function createLogger(level: Level = 'info', bindings: Record<string, unknown> = {}): Logger {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl: Level, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${oneLine(String(msg))}${fmtMeta({ ...bindings, ...(meta ?? {}) })}`;
    if (lvl === 'error' || lvl === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
    child: (b) => createLogger(level, { ...bindings, ...b }),
  };
}

/** Logger that discards everything (tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
