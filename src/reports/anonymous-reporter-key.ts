import { createHmac } from 'crypto';
import { isIPv4, isIPv6 } from 'net';

/**
 * The durable key the anonymous flood caps count a signed-out reporter's
 * filings under.
 *
 * ## What it is, and what it is worth
 *
 * A signed-out caller carries nothing the server can trust. There is no
 * account, no session, and the CSRF cookie is theirs to throw away and fetch
 * again. The ONE thing left is the network address the request arrived from,
 * so that is what this keys on, and it is worth being blunt about how much
 * weaker that is than `reporterId`:
 *
 *  - **It is not identity.** Anyone with a VPN, a phone's mobile data, or a
 *    handful of cloud instances holds as many keys as they care to pay for.
 *    The anonymous caps in `report-flood-limits.ts` therefore RAISE the cost
 *    of a sustained flood; they do not close it. The burst `@Throttle` and a
 *    moderator reading the refusal log are the rest of the answer.
 *  - **It is shared.** Carrier-grade NAT puts a whole city's mobile traffic
 *    behind a few addresses, and a community centre's wifi puts everyone in
 *    the building behind one. Two strangers can therefore collide on one key,
 *    which is why the anonymous caps are sized to leave room for several
 *    genuine reporters rather than for exactly one (see that file), and why a
 *    refusal never closes the door: its copy hands over the Contact form.
 *
 * ## What is stored
 *
 * Never the address. An HMAC-SHA256 digest under a server-held pepper, exactly
 * as `ban-evasion/ban-evasion.hash.ts` treats an email address, so the value
 * on the `reports` table cannot be walked back to a person even by somebody
 * holding the whole table. Unkeyed hashing would be no protection at all here:
 * the entire IPv4 space is 2^32 digests, which is minutes of work.
 *
 * The people this column describes are the ones who deliberately chose not to
 * have an account, so keeping the stored form one-way is the whole basis on
 * which storing anything is defensible.
 */

/**
 * Reduce a client address to the unit a cap should count.
 *
 * IPv4 is counted whole. IPv6 is counted as its /64 network prefix and NOT as
 * the full address, which is the difference between a cap that binds and one
 * that does nothing: RFC 4941 privacy addressing rotates the host half of an
 * IPv6 address on a schedule the operating system picks, so an ordinary phone
 * hands out a fresh full address every day without anyone trying. The /64 is
 * the smallest unit an ISP assigns, so it is the smallest thing a client
 * cannot rotate within.
 *
 * Returns `null` for anything that is not a routable-looking address, which
 * the caller treats as "no key" rather than as a key of its own: one shared
 * bucket for every unparseable value would be a bucket an attacker could push
 * every legitimate anonymous reporter out of.
 */
export function normalizeClientAddress(
  rawAddress: string | null | undefined,
): string | null {
  if (!rawAddress) {
    return null;
  }
  const trimmed = rawAddress.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  // An IPv6 zone index ("fe80::1%eth0") names an interface on THIS host, not
  // anything about the peer, so it is dropped before anything else looks at
  // the value.
  const withoutZone = trimmed.split('%')[0] ?? '';
  // An IPv4-mapped IPv6 address ("::ffff:203.0.113.9") is an IPv4 client that
  // reached a dual-stack listener. Keyed as the IPv4 address it actually is,
  // so the same client keys the same whichever socket it lands on.
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(withoutZone);
  const address = mappedIpv4?.[1] ?? withoutZone;

  if (isIPv4(address)) {
    return address;
  }
  if (isIPv6(address)) {
    return ipv6NetworkPrefix(address);
  }
  return null;
}

/**
 * The /64 network prefix of an already-validated IPv6 address, written back in
 * a single canonical spelling so that two spellings of one address (`2001:db8::1`
 * and `2001:0db8:0000:0000:0000:0000:0000:0001`) cannot key differently.
 */
function ipv6NetworkPrefix(address: string): string | null {
  const expanded = expandEmbeddedIpv4(address);
  const doubleColonIndex = expanded.indexOf('::');
  let groups: string[];
  if (doubleColonIndex === -1) {
    groups = expanded.split(':');
  } else {
    const head = expanded.slice(0, doubleColonIndex);
    const tail = expanded.slice(doubleColonIndex + 2);
    const headGroups = head ? head.split(':') : [];
    const tailGroups = tail ? tail.split(':') : [];
    const elidedZeroCount = 8 - headGroups.length - tailGroups.length;
    if (elidedZeroCount < 0) {
      return null;
    }
    groups = [
      ...headGroups,
      ...Array<string>(elidedZeroCount).fill('0'),
      ...tailGroups,
    ];
  }
  if (groups.length !== 8) {
    return null;
  }
  const networkGroups: string[] = [];
  for (const group of groups.slice(0, 4)) {
    const parsed = Number.parseInt(group, 16);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    networkGroups.push(parsed.toString(16));
  }
  return `${networkGroups.join(':')}::/64`;
}

/**
 * Rewrite the dotted-quad tail some IPv6 addresses carry ("2001:db8::c000:201"
 * may be written "2001:db8::192.0.2.1") as the two hextets it stands for, so
 * the group count below is always eight.
 */
function expandEmbeddedIpv4(address: string): string {
  const match = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (!match) {
    return address;
  }
  const octets = (match[2] ?? '').split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isFinite(octet))) {
    return address;
  }
  const highGroup = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
  const lowGroup = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
  return `${match[1] ?? ''}${highGroup}:${lowGroup}`;
}

/**
 * The value stored in `Report.anonymousReporterKey`: a 64-character hex
 * HMAC-SHA256 digest of the normalized client address under the pepper, or
 * `null` when there is no address to key on.
 *
 * `null` means "this filing is not bound by the anonymous durable caps", never
 * "refuse the filing". A report from somebody whose address the server could
 * not read is still a report, and the burst throttle still applies to it.
 */
export function deriveAnonymousReporterKey(
  rawAddress: string | null | undefined,
  pepper: string,
): string | null {
  const normalized = normalizeClientAddress(rawAddress);
  if (!normalized || !pepper) {
    return null;
  }
  return createHmac('sha256', pepper).update(normalized).digest('hex');
}
