import {
  HttpStatus,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_PAIRED_DEVICE_KINDS,
  type QuizshowPairedDeviceKind,
  type QuizshowPairingClaim,
  type QuizshowPairingStart,
  type QuizshowScopeKind,
} from './quizshow.contract';
import { quizshowError, quizshowErrorWithStatus } from './quizshow-errors';

/** The digits a pairing code draws from (contract 2.6): no 0 or 1, which read as O and I on a TV across a room. */
const PAIRING_CODE_ALPHABET = '23456789';

/** Draws for a code no pending entry holds; a full code space after this many reads as overload (contract 6.5). */
const PAIRING_CODE_DRAW_ATTEMPTS = 10;

/** 32 bytes of entropy, 43 base64url characters (contract 2.6 and the `@Length(43, 43)` claim body). */
const POLL_TOKEN_BYTES = 32;

/** How long an expired entry stays only to answer `quizshow_pairing_code_expired` (contract 6.5). */
const EXPIRED_PAIRING_KEEP_MS = 10 * 60 * 1000;

/** How often the pending map is swept (contract 6.5: every minute). */
const PAIRING_SWEEP_INTERVAL_MS = 60 * 1000;

/** Domain label of the ticket key, so the key differs from the access secret itself. */
const DEVICE_TICKET_KEY_LABEL = 'quizshow-device-ticket-v1';

const DEVICE_TICKET_TYPE = 'quizshow_device';

const MILLISECONDS_PER_SECOND = 1000;

/** Code lookups that may miss per requester inside the window before further lookups are refused. */
const PAIRING_MISSES_MAX = 10;

/** How far back a requester's misses count toward `PAIRING_MISSES_MAX`. */
const PAIRING_MISS_WINDOW_MS = 600_000;

/** The hash an unknown pairing id is compared against, so a miss costs the same as a wrong token. */
const UNKNOWN_POLL_TOKEN_HASH = createHash('sha256')
  .update('', 'utf8')
  .digest();

/** Claims of a device ticket (contract 6.5). `iat` and `exp` are JWT seconds (decision A27). */
export interface QuizshowDeviceTicketClaims {
  typ: 'quizshow_device';
  sid: string;
  pid: string;
  kind: QuizshowPairedDeviceKind;
  uid?: string;
  iat: number;
  exp: number;
}

export type QuizshowPairingLookup =
  | {
      ok: true;
      pairing: {
        pairingId: string;
        kind: QuizshowPairedDeviceKind;
        starterUserId: string | null;
      };
    }
  | {
      ok: false;
      code:
        | 'quizshow_pairing_code_not_found'
        | 'quizshow_pairing_code_expired'
        | 'quizshow_pairing_code_used'
        | 'quizshow_pairing_too_many_tries';
    };

/** Where the paired device plays, so the claim can route the TV or the remote (decision A6). */
export interface QuizshowPairingScope {
  kind: QuizshowScopeKind;
  eventSlug: string | null;
  gameId: string | null;
}

/** A pending pairing (contract 6.5); `paired` also keeps the scope for the claim (decision A6). */
interface QuizshowPendingPairing {
  pairingId: string;
  code: string;
  pollTokenHash: Buffer;
  kind: QuizshowPairedDeviceKind;
  starterUserId: string | null;
  createdAt: number;
  expiresAt: number;
  paired: {
    sessionId: string;
    deviceTicket: string;
    scope: QuizshowPairingScope;
  } | null;
}

function hashPollToken(pollToken: string): Buffer {
  return createHash('sha256').update(pollToken, 'utf8').digest();
}

function isPairedDeviceKind(value: unknown): value is QuizshowPairedDeviceKind {
  return (
    typeof value === 'string' &&
    (QUIZSHOW_PAIRED_DEVICE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * TV and helper pairing for Pulse Live (contract 6.5, item 9).
 *
 * Pending pairings live in memory on the single instance (contract 0.1): a
 * restart drops unclaimed codes, and the TV asks for a new code on a 404
 * claim. The poll token is kept only as its sha256 and compared in constant
 * time, so the map never holds a bearer secret a heap dump could replay.
 *
 * Device tickets are HS256 JWTs keyed by an HMAC of the access secret with a
 * fixed label, so a ticket can never verify as an access token and an access
 * token can never verify as a ticket. This service checks signature, `typ`,
 * `exp` and that `uid` matches the kind; the gateway checks that the session
 * is open and the pairing is unrevoked (decision A20). Nothing here logs a
 * code, a token or a ticket.
 */
@Injectable()
export class QuizshowDevicePairingService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly pendingById = new Map<string, QuizshowPendingPairing>();
  private readonly pairingIdByCode = new Map<string, string>();
  /** Miss times per requester, oldest first, at most `PAIRING_MISSES_MAX` each. */
  private readonly missTimesByRequester = new Map<string, number[]>();
  private sweepTimer: NodeJS.Timeout | null = null;
  /** HMAC-SHA256(auth.jwtAccessSecret, label), derived at construction so a missing secret fails at boot. */
  private readonly ticketKey: Buffer;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.ticketKey = createHmac(
      'sha256',
      config.getOrThrow<string>('auth.jwtAccessSecret'),
    )
      .update(DEVICE_TICKET_KEY_LABEL)
      .digest();
  }

  onModuleInit(): void {
    const timer = setInterval(
      () => this.sweepExpired(),
      PAIRING_SWEEP_INTERVAL_MS,
    );
    // The sweep must never keep the process alive on shutdown or in a test.
    timer.unref();
    this.sweepTimer = timer;
  }

  onModuleDestroy(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Opens a pending pairing with a fresh code; 503 `quizshow_pairing_rate_limited` when no free code turns up. */
  startPairing(
    kind: QuizshowPairedDeviceKind,
    starterUserId: string | null,
    now: number = Date.now(),
  ): QuizshowPairingStart {
    const pairingCode = this.drawFreeCode();
    if (pairingCode === null) {
      throw quizshowErrorWithStatus(
        'quizshow_pairing_rate_limited',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const pairingId = randomUUID();
    const pollToken = randomBytes(POLL_TOKEN_BYTES).toString('base64url');
    const expiresAt = now + QUIZSHOW_LIMITS.pairingCodeTtlMs;
    this.pendingById.set(pairingId, {
      pairingId,
      code: pairingCode,
      pollTokenHash: hashPollToken(pollToken),
      kind,
      starterUserId: kind === 'helper' ? starterUserId : null,
      createdAt: now,
      expiresAt,
      paired: null,
    });
    this.pairingIdByCode.set(pairingCode, pairingId);
    return { pairingId, pairingCode, pollToken, expiresAt };
  }

  /**
   * The device's poll. An unknown id, a wrong token and an expired unpaired
   * entry all answer the same 404, so a guesser learns nothing about which
   * ids exist. A paired entry answers every claim with the same ticket until
   * the code's `expiresAt`, so a TV whose first paired answer was lost on the
   * way repeats the claim and still gets its ticket. The first claim after
   * `expiresAt` hands the ticket over one last time and deletes the entry.
   */
  claimPairing(
    pairingId: string,
    pollToken: string,
    now: number = Date.now(),
  ): QuizshowPairingClaim {
    const entry = this.pendingById.get(pairingId);
    // Hash and compare even for an unknown id, so both paths cost the same.
    const presentedHash = hashPollToken(pollToken);
    const storedHash = entry?.pollTokenHash ?? UNKNOWN_POLL_TOKEN_HASH;
    const isTokenMatch = timingSafeEqual(presentedHash, storedHash);
    if (entry === undefined || !isTokenMatch) {
      throw quizshowError('quizshow_pairing_not_found');
    }
    const paired = entry.paired;
    if (paired === null) {
      if (now >= entry.expiresAt) {
        throw quizshowError('quizshow_pairing_not_found');
      }
      return { status: 'waiting', expiresAt: entry.expiresAt };
    }
    // Kept until `expiresAt`, and the code keeps reading as used meanwhile.
    // After that a claim still delivers once until the sweep drops the
    // entry: the device already sits in the session, and the TV only needs
    // its ticket.
    if (now >= entry.expiresAt) this.deleteEntry(entry);
    return {
      status: 'paired',
      deviceTicket: paired.deviceTicket,
      sessionId: paired.sessionId,
      kind: paired.scope.kind,
      eventSlug: paired.scope.eventSlug,
      gameId: paired.scope.gameId,
    };
  }

  /**
   * What `host:pairDevice` reads before pairing: the pending entry, or the
   * code that names why there is none. Every miss counts against the
   * requester; once they hold `PAIRING_MISSES_MAX` misses inside the window,
   * the lookup is refused before it runs, so guessing six digits stays slow.
   * A successful find leaves the count as it is.
   */
  findPendingByCode(
    pairingCode: string,
    requesterUserId: string,
    now: number = Date.now(),
  ): QuizshowPairingLookup {
    const recentMisses = this.recentMissTimes(requesterUserId, now);
    if (recentMisses.length >= PAIRING_MISSES_MAX) {
      return { ok: false, code: 'quizshow_pairing_too_many_tries' };
    }
    const pairingId = this.pairingIdByCode.get(pairingCode);
    const entry =
      pairingId === undefined ? undefined : this.pendingById.get(pairingId);
    if (entry === undefined) {
      this.noteMiss(requesterUserId, recentMisses, now);
      return { ok: false, code: 'quizshow_pairing_code_not_found' };
    }
    // A used code reads as used even once its ten minutes are over.
    if (entry.paired !== null) {
      this.noteMiss(requesterUserId, recentMisses, now);
      return { ok: false, code: 'quizshow_pairing_code_used' };
    }
    if (now >= entry.expiresAt) {
      this.noteMiss(requesterUserId, recentMisses, now);
      return { ok: false, code: 'quizshow_pairing_code_expired' };
    }
    return {
      ok: true,
      pairing: {
        pairingId: entry.pairingId,
        kind: entry.kind,
        starterUserId: entry.starterUserId,
      },
    };
  }

  /**
   * Marks the entry paired and keeps the ticket for the device's next claim.
   * A missing entry (swept or claimed meanwhile) is left alone: the device
   * then reads a 404 and shows a new code. A second call keeps the first ticket.
   * True when this call paired the entry; false when it was missing or already paired.
   */
  completePairing(
    pairingId: string,
    sessionId: string,
    deviceTicket: string,
    scope: QuizshowPairingScope,
  ): boolean {
    const entry = this.pendingById.get(pairingId);
    if (entry === undefined || entry.paired !== null) return false;
    entry.paired = {
      sessionId,
      deviceTicket,
      scope: {
        kind: scope.kind,
        eventSlug: scope.eventSlug,
        gameId: scope.gameId,
      },
    };
    return true;
  }

  /** Signs a device ticket (contract 6.5); `uid` rides on helper tickets only, and a helper ticket needs one. */
  mintDeviceTicket(input: {
    sessionId: string;
    pairingId: string;
    kind: QuizshowPairedDeviceKind;
    helperUserId: string | null;
    now?: number;
  }): string {
    if (input.kind === 'helper' && input.helperUserId === null) {
      throw new Error(
        'A helper device ticket needs the helper user id; the pairing has no starter.',
      );
    }
    const issuedAtSeconds = Math.floor(
      (input.now ?? Date.now()) / MILLISECONDS_PER_SECOND,
    );
    const claims: QuizshowDeviceTicketClaims = {
      typ: DEVICE_TICKET_TYPE,
      sid: input.sessionId,
      pid: input.pairingId,
      kind: input.kind,
      iat: issuedAtSeconds,
      exp:
        issuedAtSeconds +
        QUIZSHOW_LIMITS.deviceTicketTtlMs / MILLISECONDS_PER_SECOND,
    };
    if (input.kind === 'helper' && input.helperUserId !== null) {
      claims.uid = input.helperUserId;
    }
    return this.jwt.sign(claims, {
      secret: this.ticketKey,
      algorithm: 'HS256',
    });
  }

  /** Signature, `typ` and `exp`; null on any failure. The session and revocation checks are the gateway's. */
  verifyDeviceTicket(
    ticket: string,
    now: number = Date.now(),
  ): QuizshowDeviceTicketClaims | null {
    const nowSeconds = Math.floor(now / MILLISECONDS_PER_SECOND);
    let payload: Record<string, unknown>;
    try {
      payload = this.jwt.verify<Record<string, unknown>>(ticket, {
        secret: this.ticketKey,
        algorithms: ['HS256'],
        clockTimestamp: nowSeconds,
      });
    } catch {
      return null;
    }
    const { typ, sid, pid, kind, uid, iat, exp } = payload;
    if (typ !== DEVICE_TICKET_TYPE) return null;
    if (typeof sid !== 'string' || typeof pid !== 'string') return null;
    if (!isPairedDeviceKind(kind)) return null;
    if (typeof iat !== 'number' || typeof exp !== 'number') return null;
    // The library checks `exp` too; this repeats it so a ticket without one never passes.
    if (nowSeconds >= exp) return null;
    if (uid !== undefined && typeof uid !== 'string') return null;
    // A helper ticket carries its member and a screen ticket carries nobody.
    if ((kind === 'helper') !== (typeof uid === 'string')) return null;
    const claims: QuizshowDeviceTicketClaims = {
      typ: DEVICE_TICKET_TYPE,
      sid,
      pid,
      kind,
      iat,
      exp,
    };
    if (typeof uid === 'string') claims.uid = uid;
    return claims;
  }

  /**
   * Drops entries 10 minutes past `expiresAt`; until then an expired code
   * still names itself as expired. Also drops misses older than the window.
   */
  sweepExpired(now: number = Date.now()): void {
    for (const entry of [...this.pendingById.values()]) {
      if (now >= entry.expiresAt + EXPIRED_PAIRING_KEEP_MS) {
        this.deleteEntry(entry);
      }
    }
    for (const requesterUserId of [...this.missTimesByRequester.keys()]) {
      this.recentMissTimes(requesterUserId, now);
    }
  }

  /** The requester's misses inside the window; stores the pruned list, or drops the requester when none remain. */
  private recentMissTimes(requesterUserId: string, now: number): number[] {
    const missTimes = this.missTimesByRequester.get(requesterUserId);
    if (missTimes === undefined) return [];
    const recent = missTimes.filter(
      (missedAt) => now - missedAt < PAIRING_MISS_WINDOW_MS,
    );
    if (recent.length === 0) {
      this.missTimesByRequester.delete(requesterUserId);
    } else {
      this.missTimesByRequester.set(requesterUserId, recent);
    }
    return recent;
  }

  private noteMiss(
    requesterUserId: string,
    recentMisses: number[],
    now: number,
  ): void {
    this.missTimesByRequester.set(requesterUserId, [...recentMisses, now]);
  }

  private deleteEntry(entry: QuizshowPendingPairing): void {
    this.pendingById.delete(entry.pairingId);
    if (this.pairingIdByCode.get(entry.code) === entry.pairingId) {
      this.pairingIdByCode.delete(entry.code);
    }
  }

  /** A code no entry in the map holds, so a lookup by code is never ambiguous; null after every attempt collided. */
  private drawFreeCode(): string | null {
    for (let attempt = 0; attempt < PAIRING_CODE_DRAW_ATTEMPTS; attempt += 1) {
      let pairingCode = '';
      for (
        let position = 0;
        position < QUIZSHOW_LIMITS.pairingCodeLength;
        position += 1
      ) {
        pairingCode +=
          PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
      }
      if (!this.pairingIdByCode.has(pairingCode)) return pairingCode;
    }
    return null;
  }
}
