/**
 * The logger writes one record per line: values that come from outside (URLs, labels, error texts from websites or API
 * clients) must not be able to break a record into several lines or smuggle terminal escapes into the logs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/log.js';

function capture() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line));
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const LS = String.fromCharCode(0x2028);
const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);
const UNSAFE = /[\r\n\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

describe('createLogger', () => {
  it('keeps plain values readable', () => {
    const lines = capture();
    createLogger('debug').info('link: add', { label: 'Matt', watchId: 3, url: 'https://unpeg.io/', note: 'two words' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ INFO  link: add label=Matt watchId=3 url=https:\/\/unpeg\.io\/ note="two words"$/);
  });

  it('quotes and escapes line breaks, separators and control characters in values and messages', () => {
    const lines = capture();
    const forged = `x\n2026-10-05T00:00:00.000Z INFO  link: add label=admin`;
    const log = createLogger('debug');
    log.info('link: scan', { url: forged, label: `a${LS}b`, term: `${ESC}[2Jboom${CSI}31m`, obj: { s: `q${LS}` } });
    log.warn(`message with\nnewline`, {});
    log.error('failed', { err: new Error(`bad\r\nINFO forged`) });
    const out = lines.join('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(UNSAFE.test(line)).toBe(false);
    expect(out).toContain('url="x\\n2026-10-05T00:00:00.000Z INFO  link: add label=admin"');
    expect(out).toContain('label="a\\u2028b"');
    expect(out).toContain('term="\\u001b[2Jboom\\u009b31m"');
    expect(out).toContain('obj={"s":"q\\u2028"}');
    expect(out).toContain('message with\\nnewline');
    expect(out).toMatch(/err="Error: bad\\r\\nINFO forged\\n {4}at /);
  });

  it('still prints ordinary error stacks as they are', () => {
    const lines = capture();
    createLogger('debug').error('boom', { err: new Error('plain failure') });
    expect(lines[0]).toContain('err=Error: plain failure\n    at ');
  });
});
