import type { Logger } from './types.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function fmtMeta(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    let s: string;
    if (v instanceof Error) s = v.stack ?? v.message;
    else if (typeof v === 'string') s = /\s/.test(v) ? JSON.stringify(v) : v;
    else {
      try {
        s = JSON.stringify(v);
      } catch {
        s = String(v);
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
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}${fmtMeta({ ...bindings, ...(meta ?? {}) })}`;
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
