import { readFileSync } from 'node:fs';

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** package.json version, e.g. "2.0.0". */
export const APP_VERSION = readPackageVersion();

/** Short display form: "2.0.0" → "2.0". */
export const DISPLAY_VERSION = APP_VERSION.split('.').slice(0, 2).join('.');

const sha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || '';

/** Identity of the running build: the git commit Railway deployed (so every new push counts), else the package version. */
export const BUILD_ID = sha ? `${APP_VERSION}+${sha.slice(0, 12)}` : APP_VERSION;

/** First line of the deployed commit message (Railway GitHub deploys), if any. */
export const COMMIT_MESSAGE = (process.env.RAILWAY_GIT_COMMIT_MESSAGE ?? '').split('\n')[0].trim().slice(0, 300);

export const COMMIT_SHORT = sha.slice(0, 7);
