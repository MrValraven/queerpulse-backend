import { lookup } from 'node:dns/promises';
import {
  Agent as HttpsAgent,
  type AgentOptions as HttpsAgentOptions,
} from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Agent as UndiciAgent } from 'undici';

/**
 * SSRF hardening for the link-preview fetcher. An unfurl endpoint fetches a
 * URL *the user chose*, so without these guards it becomes a confused deputy:
 * a member could point it at `http://169.254.169.254/` (cloud metadata),
 * `http://127.0.0.1:6379/` (a local Redis), or an internal `10.x` service and
 * read the response through the preview. Everything here exists to stop the
 * server from making a request to any address that isn't a public host.
 *
 * Layers:
 *  1. Scheme allow-list — only http/https (no file:, gopher:, data:, ...).
 *  2. DNS resolution + IP-range block — every resolved address must be a
 *     public unicast IP (rejects loopback, link-local, private, CGNAT, ULA,
 *     multicast, reserved, and IPv4-mapped/embedded forms of all of those).
 *  3. Redirect cap with per-hop re-validation — a public URL can 3xx to an
 *     internal one, so redirects are followed manually and each Location is
 *     re-checked from scratch.
 *  4. Timeout + response-size cap live in `safeFetchHtml`.
 *  5. Connection pinning — closes the TOCTOU / DNS-rebinding window. Validating
 *     with `lookup()` and then handing the *hostname* to `fetch`/`web-push`
 *     lets those re-resolve DNS at connect time, so a rebinding host can answer
 *     with a public IP for our check and a private one for the real socket.
 *     `assertPublicUrl` now returns the exact validated IP, and callers pin the
 *     socket to it via a custom `lookup` (an `undici` dispatcher for `fetch`
 *     paths, an `https.Agent` for `web-push`). The host header / TLS SNI stay
 *     the original hostname, so certificate validation is unaffected — only the
 *     address the socket dials is fixed to the one we already vetted.
 */

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 4000;
const MAX_BYTES = 512 * 1024; // 512 KB is ample for a document <head>.

/** Parse a dotted-quad into its 32-bit integer, or null if malformed. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** True when a dotted-quad falls in any non-public IPv4 range. */
function isPrivateIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // unparseable → treat as unsafe
  const inRange = (base: string, prefix: number): boolean => {
    const baseInt = ipv4ToInt(base)!;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (baseInt & mask);
  };
  return (
    inRange('0.0.0.0', 8) || // "this" network / unspecified
    inRange('10.0.0.0', 8) || // private
    inRange('100.64.0.0', 10) || // CGNAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local (incl. cloud metadata 169.254.169.254)
    inRange('172.16.0.0', 12) || // private
    inRange('192.0.0.0', 24) || // IETF protocol assignments
    inRange('192.0.2.0', 24) || // TEST-NET-1
    inRange('192.168.0.0', 16) || // private
    inRange('198.18.0.0', 15) || // benchmarking
    inRange('198.51.100.0', 24) || // TEST-NET-2
    inRange('203.0.113.0', 24) || // TEST-NET-3
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved / broadcast
  );
}

/** True when an IPv6 address is anything other than plain global unicast: an
 *  IPv4-mapped/NAT64 form wrapping a private IPv4, a 6to4 or Teredo tunnel
 *  address (both of which carry an arbitrary IPv4 inside), the documentation
 *  block, or anything at all outside the 2000::/3 global-unicast allocation
 *  (loopback, link-local, ULA, multicast, discard-only). */
function isPrivateIpv6(ip: string): boolean {
  const address = ip.toLowerCase().split('%')[0] ?? ip; // strip any zone id
  if (address === '::1' || address === '::') return true;

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) can embed a
  // dotted-quad — validate the embedded v4 with the v4 rules.
  const embedded = address.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)?.[1];
  if (
    embedded &&
    (address.startsWith('::ffff:') || address.startsWith('64:ff9b:'))
  ) {
    return isPrivateIpv4(embedded);
  }

  const hextets = address.split(':');
  const firstHextet = hextets[0] ?? '';
  const leading = parseInt(firstHextet || '0', 16);
  if (Number.isNaN(leading)) return true;

  // ALLOW-LIST, not a block-list: every address IANA has allocated for global
  // unicast lives in 2000::/3, so anything outside it is refused outright
  // rather than enumerated. That covers ::1 and :: (handled above anyway),
  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast, 100::/64
  // discard-only, and the hex-form 64:ff9b::/96 NAT64 addresses the dotted-quad
  // branch above only catches when they are written with an embedded IPv4.
  if ((leading & 0xe000) !== 0x2000) return true;

  // Inside 2000::/3, the tunnelling and documentation blocks. These are the
  // holes the previous prefix list left open: 6to4 and Teredo both carry an
  // arbitrary IPv4 address inside an address that otherwise reads as ordinary
  // global unicast, so `2002:0a00:0001::` is a route to 10.0.0.1 that passed
  // every check above.
  if (leading === 0x2002) return true; // 2002::/16 — 6to4
  // The second hextet decides between the special-purpose 2001:0::/32 (Teredo)
  // and 2001:db8::/32 (documentation) and ordinary 2001: allocations such as
  // Google's 2001:4860::/32. An omitted hextet ('2001::…' after compression)
  // parses as 0, which is exactly the Teredo case.
  const secondHextet = hextets[1] ?? '';
  const second = parseInt(secondHextet || '0', 16);
  if (leading === 0x2001 && !Number.isNaN(second)) {
    if (second === 0x0000) return true; // 2001:0::/32 — Teredo
    if (second === 0x0db8) return true; // 2001:db8::/32 — documentation
  }
  return false;
}

function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true; // not a recognizable IP → refuse
}

/** A URL that passed every SSRF check, plus the exact validated IP the caller
 *  must pin the socket to (see {@link pinnedDispatcher} / {@link pinnedHttpsAgent}). */
export interface ValidatedTarget {
  /** The parsed, scheme-checked URL. Its hostname is still the ORIGINAL host so
   *  TLS SNI / cert validation and the Host header stay correct. */
  url: URL;
  /** The vetted public IP literal the connection must dial. */
  address: string;
  /** IP family of {@link address} (4 or 6). */
  family: 4 | 6;
}

/** Reject a URL whose scheme isn't http(s) or whose host resolves to any
 *  non-public address. Throws on any violation; on success returns the parsed
 *  URL together with the exact validated IP the caller pins to (closing the
 *  resolve-vs-connect TOCTOU window). Exported so other outbound-request paths
 *  (e.g. web-push delivery, which POSTs to a member-supplied endpoint) can reuse
 *  the same guard AND the same pin. */
export async function assertPublicUrl(
  rawUrl: string,
): Promise<ValidatedTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('unparseable-url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('bad-scheme');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // unwrap [::1]

  // A literal IP in the host bypasses DNS — check it directly. There is no
  // rebinding risk (no name to re-resolve), and we pin to the literal itself.
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (isBlockedIp(hostname)) throw new Error('blocked-ip');
    return { url: parsed, address: hostname, family: literalFamily as 4 | 6 };
  }

  // Resolve every A/AAAA record; if ANY is non-public, refuse (a host that
  // resolves to both a public and a private address is still an SSRF vector).
  const records = await lookup(hostname, { all: true });
  if (records.length === 0) throw new Error('no-dns');
  for (const record of records) {
    if (isBlockedIp(record.address)) throw new Error('blocked-ip');
  }
  // Every record is public; pin the connection to the FIRST one so the socket
  // dials exactly the address we vetted, not whatever a second resolution
  // (undici's / web-push's own) might return a moment later.
  const pin = records[0];
  if (!pin) throw new Error('no-dns');
  const pinFamily = isIP(pin.address);
  if (!pinFamily) throw new Error('blocked-ip');
  return { url: parsed, address: pin.address, family: pinFamily as 4 | 6 };
}

/** A `dns.lookup`-shaped function that ignores the hostname and always yields
 *  the pre-validated {@link ValidatedTarget.address}. Handles both the
 *  `(err, address, family)` and `{ all: true }` → `(err, [{address,family}])`
 *  callback shapes that Node's net stack / undici use. */
function makePinnedLookup(address: string, family: 4 | 6): LookupFunction {
  const pinned = ((
    _hostname: string,
    options: unknown,
    callback?: unknown,
  ): void => {
    const done = (typeof options === 'function' ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void;
    const wantsAll =
      typeof options === 'object' &&
      options !== null &&
      (options as { all?: boolean }).all === true;
    if (wantsAll) {
      done(null, [{ address, family }]);
    } else {
      done(null, address, family);
    }
  }) as unknown as LookupFunction;
  return pinned;
}

/** An `undici` dispatcher that pins every connection it makes to the validated
 *  IP — pass as `fetch(url, { dispatcher })` for the `fetch`-based paths
 *  (link-preview, geocode). One-shot: built per validated target, not pooled. */
export function pinnedDispatcher(target: ValidatedTarget): UndiciAgent {
  return new UndiciAgent({
    connect: { lookup: makePinnedLookup(target.address, target.family) },
  });
}

/** An `https.Agent` that pins its socket to the validated IP — for `web-push`,
 *  which uses Node's `https` (not `fetch`) and accepts an `agent` option. The
 *  TLS servername stays the original hostname, so cert validation is unchanged. */
export function pinnedHttpsAgent(target: ValidatedTarget): HttpsAgent {
  const options: HttpsAgentOptions & { lookup: LookupFunction } = {
    lookup: makePinnedLookup(target.address, target.family),
    keepAlive: false,
    maxSockets: 1,
  };
  return new HttpsAgent(options);
}

/**
 * Fetch `rawUrl` as HTML, SSRF-safe. Follows up to `MAX_REDIRECTS` redirects,
 * re-validating each hop; enforces a wall-clock timeout and a hard byte cap on
 * the response body (reads the stream and aborts past the cap rather than
 * trusting Content-Length). Returns the decoded HTML and the final URL, or
 * null when the target isn't fetchable/HTML. Never throws for the expected
 * "can't preview this" cases — callers treat null as "no card".
 */
export async function safeFetchHtml(
  rawUrl: string,
): Promise<{ html: string; finalUrl: string } | null> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let validated: ValidatedTarget;
    try {
      validated = await assertPublicUrl(currentUrl);
    } catch {
      return null;
    }

    // Pin this hop's socket to the exact IP we just vetted (closes the
    // resolve-vs-connect rebinding window). Set on a narrowly-cast field
    // because Node honours `dispatcher` at runtime even where the DOM
    // `RequestInit` type doesn't declare it.
    const requestInit: RequestInit = {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // A UA + Accept nudges sites to return HTML with OG tags rather than
        // a bot wall; we deliberately don't send cookies/credentials.
        'user-agent': 'QueerPulseBot/1.0 (+link-preview)',
        accept: 'text/html,application/xhtml+xml',
      },
    };
    (requestInit as { dispatcher?: unknown }).dispatcher =
      pinnedDispatcher(validated);

    let response: Response;
    try {
      response = await fetch(validated.url.toString(), requestInit);
    } catch {
      return null; // timeout, connection refused, DNS race, etc.
    }

    // Manual redirect handling: re-validate the next hop from scratch.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      try {
        currentUrl = new URL(location, validated.url).toString();
      } catch {
        return null;
      }
      continue;
    }

    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (
      contentType &&
      !/text\/html|application\/xhtml\+xml/i.test(contentType)
    ) {
      return null; // not an HTML document — nothing to unfurl
    }

    const html = await readCapped(response);
    if (html === null) return null;
    return { html, finalUrl: validated.url.toString() };
  }
  return null; // too many redirects
}

/** Read a response body up to MAX_BYTES, decoding as UTF-8. Returns null if the
 *  body can't be read; truncates (doesn't error) once the cap is hit — the
 *  document <head> with its meta tags is near the top anyway. */
async function readCapped(response: Response): Promise<string | null> {
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (received >= MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    return null;
  }
  return out;
}
