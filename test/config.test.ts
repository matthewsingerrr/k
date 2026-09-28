/**
 * Config loading: Railway volume detection and the new budget/limit variables.
 */

import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isInside, loadConfig } from '../src/config.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function onRailway(volume: string | undefined, dataDir: string | undefined) {
  vi.stubEnv('RAILWAY_ENVIRONMENT', 'production');
  vi.stubEnv('RAILWAY_VOLUME_MOUNT_PATH', volume ?? '');
  vi.stubEnv('DATA_DIR', dataDir ?? '');
  return loadConfig({ requireToken: false });
}

describe('loadConfig: Railway volume detection', () => {
  it('treats only DATA_DIR at or below the volume mount path as persistent (path boundaries, not string prefixes)', () => {
    expect(onRailway('/data', '/data2').dataDirPersistent).toBe(false);
    expect(onRailway('/data', '/database').dataDirPersistent).toBe(false);
    expect(onRailway('/data', '/data/db').dataDirPersistent).toBe(true);
    expect(onRailway('/data', '/data').dataDirPersistent).toBe(true);
    expect(onRailway('/data', undefined)).toMatchObject({ dataDir: path.resolve('/data'), dataDirPersistent: true });
    expect(onRailway('/data/', '/data/x').dataDirPersistent).toBe(true);
    expect(onRailway(undefined, '/data').dataDirPersistent).toBe(false);
  });

  it('isInside', () => {
    expect(isInside('/data', '/data')).toBe(true);
    expect(isInside('/data', '/data/a/b')).toBe(true);
    expect(isInside('/data', '/data2')).toBe(false);
    expect(isInside('/data', '/')).toBe(false);
    expect(isInside('/data', '/data/..foo')).toBe(true);
  });
});

describe('loadConfig: budgets and limits', () => {
  it('reads the Cert Spotter budget and the per-server watch limit', () => {
    expect(loadConfig({ requireToken: false })).toMatchObject({ certspotterQueriesPerHour: 10, maxWatchesPerGuild: 50 });
    vi.stubEnv('CERTSPOTTER_QUERIES_PER_HOUR', '100');
    vi.stubEnv('MAX_WATCHES_PER_GUILD', '0');
    expect(loadConfig({ requireToken: false })).toMatchObject({ certspotterQueriesPerHour: 100, maxWatchesPerGuild: 0 });
    vi.stubEnv('CERTSPOTTER_QUERIES_PER_HOUR', '0');
    expect(() => loadConfig({ requireToken: false })).toThrow(/CERTSPOTTER_QUERIES_PER_HOUR/);
  });
});
