/**
 * Technology fingerprinting ("what is this site built with?") for the Link API's /scan.
 * STUB — to be implemented. Keep the exported API exactly as declared.
 */
import type { TechHit } from './types.js';

export interface TechInput {
  url: string;
  /** Lowercase response headers of the homepage. */
  headers: Record<string, string>;
  /** Raw homepage HTML (may be ''). */
  html: string;
  /** Absolute URLs of scripts / styles / preloads on the homepage. */
  scripts: string[];
  styles: string[];
  /** <meta name="generator"> */
  generator: string | null;
  /** Concatenated (capped) source of the site's own JS bundles, for library banners & SDK names (may be ''). */
  js: string;
  /** Hostnames referenced in code / HTML. */
  hosts: string[];
  /** Cookie names from set-cookie. */
  cookies: string[];
}

/**
 * Detect technologies from headers, HTML, script/style URLs, JS bundle contents, hostnames and cookies.
 * Pure & synchronous, must be fast (< 50ms on a 5MB input) and never throw. Results deduped by name, sorted by
 * category then name.
 */
export function detectTech(input: TechInput): TechHit[] {
  throw new Error('not implemented');
}
