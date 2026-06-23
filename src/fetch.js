// Shared HTTP helper: browser-like headers, throttling, retries, and a
// friendly error when the sandbox network egress allowlist blocks a host.
import { config } from './config.js';

let lastRequestAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Raised when a host is not in the environment's egress allowlist. The sync
// layer catches this to leave cached data untouched instead of wiping it.
export class EgressBlockedError extends Error {
  constructor(host) {
    super(
      `Host not in network egress allowlist: ${host}. ` +
        `Add it to your environment's egress settings (or run locally) to enable live scraping.`
    );
    this.name = 'EgressBlockedError';
    this.host = host;
  }
}

async function throttle() {
  const now = Date.now();
  const wait = config.requestDelayMs - (now - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/**
 * Fetch a URL and return its text body. Retries transient failures with
 * exponential backoff. Throws EgressBlockedError when the sandbox blocks the host.
 */
export async function fetchText(url, { retries = 3 } = {}) {
  const host = new URL(url).host;
  let attempt = 0;
  let lastErr;

  while (attempt <= retries) {
    await throttle();
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': config.userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,tr;q=0.8',
        },
        redirect: 'follow',
      });

      if (res.status === 403) {
        const body = await res.text().catch(() => '');
        // The sandbox proxy returns this body + header for blocked hosts.
        if (
          res.headers.get('x-deny-reason') === 'host_not_allowed' ||
          /not in allowlist/i.test(body)
        ) {
          throw new EgressBlockedError(host);
        }
        throw new Error(`HTTP 403 for ${url}`);
      }

      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return await res.text();
    } catch (err) {
      if (err instanceof EgressBlockedError) throw err; // not worth retrying
      lastErr = err;
      attempt += 1;
      if (attempt > retries) break;
      const backoff = 1000 * 2 ** (attempt - 1);
      await sleep(backoff);
    }
  }
  throw lastErr;
}
