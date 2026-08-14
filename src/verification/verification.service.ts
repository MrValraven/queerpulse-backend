import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { cursorPaginate, CursorKeyset } from '../common/cursor-pagination';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { BulkDecideVerificationRequestsResultDTO } from './dto/bulk-decide-verification-requests.dto';
import { StartPhoneVerificationDto } from './dto/start-phone-verification.dto';
import { VerifyPhoneDto } from './dto/verify-phone.dto';
import { MemberVerification } from './entities/member-verification.entity';
import { VerificationEvent } from './entities/verification-event.entity';
import { VerificationRequest } from './entities/verification-request.entity';
import {
  IDENTITY_VERIFICATION_PROVIDER,
  IdentityVerificationProvider,
} from './providers/identity-verification.provider';
import {
  PHONE_VERIFICATION_PROVIDER,
  PhoneVerificationProvider,
} from './providers/phone-verification.provider';
import {
  AdminVerificationDTO,
  AdminVerificationListDTO,
  AdminVerificationRequestDetailDTO,
  AdminVerificationRequestListDTO,
  AdminVerificationSort,
  toAdminVerificationDTO,
  toAdminVerificationRequestDetailDTO,
  toAdminVerificationRequestDTO,
  toVerificationEventDTO,
  toVerificationStatusDTO,
  VerificationEventDTO,
  VerificationRequestSort,
  VerificationSignalsDTO,
  VerificationStatusDTO,
} from './verification-response';
import {
  LEGAL_TRANSITIONS,
  VerificationRequestStatus,
} from './verification-request-status';
import {
  levelRank,
  meetsLevel,
  VERIFICATION_LEVEL_ORDER,
  VerificationEventAction,
  VerificationGrantedBy,
  VerificationLevel,
  VerificationType,
} from './verification-level';

/**
 * Machine-readable code the frontend keys the step-up prompt off. Emitted in
 * the 403 body from `requireLevel`, alongside `requiredLevel`.
 */
export const VERIFICATION_REQUIRED_CODE = 'VERIFICATION_REQUIRED';

/** Filter/sort/page input for `listForAdmin`. Every field is optional — an
 * empty filter is "first page, newest first, no search, every level". */
export interface AdminVerificationListFilter {
  level?: VerificationLevel;
  query?: string;
  sort?: AdminVerificationSort;
  cursor?: string;
}

/** Rows-per-page for the admin console's list + "Load more". */
const ADMIN_VERIFICATION_PAGE_SIZE = 25;

/** Filter/sort/page input for `listRequestsForAdmin`. Every field is
 * optional — an empty filter is "first page, newest-submitted first, no
 * search, every status, every type". */
export interface AdminVerificationRequestListFilter {
  status?: VerificationRequestStatus;
  type?: VerificationType;
  query?: string;
  sort?: VerificationRequestSort;
  cursor?: string;
}

/** Rows-per-page for the admin request queue's list + "Load more". */
const ADMIN_VERIFICATION_REQUEST_PAGE_SIZE = 25;

/** Input for `submitRequest`. `type` defaults to `identity` — the only kind
 * that exists today (see `VerificationType`). */
export interface SubmitVerificationRequestInput {
  type?: VerificationType;
  requestedLevel: VerificationLevel;
  context?: string | null;
  evidenceRef?: string | null;
}

/** A request is "open" (blocks a new submission for the same member+type)
 * while it is anywhere in the review loop — not yet decided, and not already
 * withdrawn/terminal. */
const OPEN_REQUEST_STATUSES: readonly VerificationRequestStatus[] = [
  VerificationRequestStatus.Pending,
  VerificationRequestStatus.InReview,
  VerificationRequestStatus.Appealing,
];

/** The moderator action `decideRequest` accepts, mapped 1:1 to the request's
 * next status via `targetStatusForAction`. */
export type VerificationRequestDecisionAction =
  'in_review' | 'approve' | 'reject';

/** SQL `CASE` expression mapping `member_verifications.level` to its rank on
 * the ladder (`VERIFICATION_LEVEL_ORDER`'s index) for the `sort=level` keyset
 * — mirrors `levelRank` in SQL since a query can't call a JS function. Built
 * from the enum's own fixed values (never user input), so no bind parameter
 * is needed. */
const LEVEL_RANK_CASE_EXPRESSION = `CASE "member_verification"."level" ${VERIFICATION_LEVEL_ORDER.map(
  (level, index) => `WHEN '${level}' THEN ${index}`,
).join(' ')} END`;

/** Pure whole-day difference between `from` and `to` — never negative
 * (floored at 0), and floored rather than rounded so an account created a
 * few hours ago reads as day 0, not 1. Kept as a standalone pure function
 * (no implicit `Date.now()`) so `computeSignals`'s `accountAgeDays` is easy
 * to unit-test with fixed dates on both sides. */
function wholeDaysBetween(from: Date, to: Date): number {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.max(
    0,
    Math.floor((to.getTime() - from.getTime()) / millisecondsPerDay),
  );
}

/**
 * Owns a member's identity-assurance level and the step-up flows that raise it.
 *
 * The email floor is IMPLICIT: sign-in is Google-only, so any account already
 * proves email control. `levelForUser` therefore resolves a member with no row
 * (or a seeded `email` row) to `email` without a write. Phone/ID are real
 * events that create/raise a row. The document check itself never touches this
 * service — it lives behind `IdentityVerificationProvider`.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    @InjectRepository(MemberVerification)
    private readonly repo: Repository<MemberVerification>,
    @InjectRepository(VerificationEvent)
    private readonly eventRepo: Repository<VerificationEvent>,
    @InjectRepository(VerificationRequest)
    private readonly requestRepo: Repository<VerificationRequest>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @Inject(PHONE_VERIFICATION_PROVIDER)
    private readonly phoneProvider: PhoneVerificationProvider,
    @Inject(IDENTITY_VERIFICATION_PROVIDER)
    private readonly identityProvider: IdentityVerificationProvider,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  /** The member's current level (email floor when no explicit row exists). */
  async levelForUser(userId: string): Promise<VerificationLevel> {
    const row = await this.repo.findOne({ where: { userId } });
    return row?.level ?? VerificationLevel.Email;
  }

  /** Batched levels for a set of members (badge hydration). Missing rows resolve
   * to the email floor so every requested id is present in the map. */
  async levelsForUsers(
    userIds: string[],
  ): Promise<Map<string, VerificationLevel>> {
    const map = new Map<string, VerificationLevel>();
    if (!userIds.length) return map;
    const unique = [...new Set(userIds)];
    const rows = await this.repo.find({ where: { userId: In(unique) } });
    for (const row of rows) map.set(row.userId, row.level);
    for (const id of unique) {
      if (!map.has(id)) map.set(id, VerificationLevel.Email);
    }
    return map;
  }

  /**
   * Gate a high-risk action. Throws a typed 403 the frontend can turn into a
   * step-up prompt (`code: VERIFICATION_REQUIRED`, `requiredLevel`).
   */
  async requireLevel(
    userId: string,
    required: VerificationLevel,
  ): Promise<void> {
    const current = await this.levelForUser(userId);
    if (!meetsLevel(current, required)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'A higher verification level is needed for this',
        code: VERIFICATION_REQUIRED_CODE,
        requiredLevel: required,
        currentLevel: current,
      });
    }
  }

  async getStatus(userId: string): Promise<VerificationStatusDTO> {
    const row = await this.repo.findOne({ where: { userId } });
    return toVerificationStatusDTO(row?.level ?? VerificationLevel.Email, row);
  }

  // --- phone step-up ---

  async startPhone(
    userId: string,
    dto: StartPhoneVerificationDto,
  ): Promise<{ started: true }> {
    await this.phoneProvider.startChallenge(userId, dto.phoneNumber);
    return { started: true };
  }

  async verifyPhone(
    userId: string,
    dto: VerifyPhoneDto,
  ): Promise<VerificationStatusDTO> {
    const ok = await this.phoneProvider.checkChallenge(userId, dto.code);
    if (!ok) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'That code did not match — request a new one and try again',
        code: 'PHONE_CODE_INVALID',
      });
    }
    // Phase 2 (Task 6): manual-first by default. The OTP check above is a
    // real, recorded provider event regardless of the flag — only the
    // automatic level-RAISE is dormant. With VERIFICATION_AUTOMATED_ELEVATION
    // unset/false, a member reaches `phone` only through an approved
    // verification request (`decideRequest`'s approve path); flip the flag on
    // to restore the old instant-raise seam.
    if (this.automatedElevationEnabled()) {
      await this.raiseTo(
        userId,
        VerificationLevel.Phone,
        'phone_otp',
        'dev_phone',
      );
    }
    return this.getStatus(userId);
  }

  // --- identity step-up ---

  async startIdentity(
    userId: string,
  ): Promise<{ redirectUrl: string; providerRef: string }> {
    const session = await this.identityProvider.createSession(userId);
    // Persist the pending ref on the member's row so the (later, possibly
    // unauthenticated) callback can map the result back to this member.
    const row = await this.loadOrCreate(userId);
    row.provider = this.identityProvider.name;
    row.providerRef = session.providerRef;
    await this.repo.save(row);
    return {
      redirectUrl: session.redirectUrl,
      providerRef: session.providerRef,
    };
  }

  /**
   * Provider callback (webhook seam). On success, elevate the member who owns
   * the `providerRef` to `id_verified`. Idempotent — a repeat callback is a
   * no-op once the member is already ID-verified.
   */
  async handleIdentityCallback(payload: unknown): Promise<{ received: true }> {
    const result = this.identityProvider.parseCallback(payload);
    const row = await this.repo.findOne({
      where: { providerRef: result.providerRef },
    });
    if (!row) {
      throw new NotFoundException('Unknown verification session');
    }
    // Phase 2 (Task 6): manual-first by default. The callback is still
    // parsed and matched to the member's `providerRef` above (the provider
    // event IS recorded/reconciled) regardless of the flag — only the
    // automatic level-RAISE is dormant. With VERIFICATION_AUTOMATED_ELEVATION
    // unset/false, a member reaches `id_verified` only through an approved
    // verification request (`decideRequest`'s approve path).
    if (
      this.automatedElevationEnabled() &&
      result.verified &&
      row.level !== VerificationLevel.IdVerified
    ) {
      row.level = VerificationLevel.IdVerified;
      row.method = 'id_document';
      row.verifiedAt = new Date();
      await this.repo.save(row);
    }
    return { received: true };
  }

  // --- admin (manual review / override) ---

  /**
   * Counted/searchable/sorted/paginated verification rows for the admin
   * console — the `GET /admin/verifications` payload in full: rows, per-level
   * tab counts, and a keyset cursor for "load more".
   *
   * The paginated query is JOIN-FREE on purpose. TypeORM's `.take()`/`.skip()`
   * forces `getMany()` down its two-query "distinct pagination" path whenever
   * `joinAttributes.length > 0` — that's keyed on join PRESENCE, not
   * cardinality, so a join being 1:1 does NOT exempt it. That path rewrites
   * the `ORDER BY` and assumes any string containing a `.` is `alias.column`;
   * both keysets below are raw SQL EXPRESSIONS (a `date_trunc(...)` call and a
   * `CASE ... END` rank), which it splits on `.` and fails to resolve via
   * `findAliasByName`, throwing at query time. Demo mode never exercises this
   * (it never hits Postgres), so the trap only surfaces live — see
   * `feed.service.ts` (`fetchCandidates`'s `new_member`/`community_new_member`
   * branches) for the same trap and the same correlated-`EXISTS` fix. The
   * member-search filter below is therefore an `EXISTS` against
   * `profiles`/`users` rather than a `leftJoin`, and `profiles`/`users` are
   * hydrated afterward via one batched `MemberLookup.byUserIds` call (mirrors
   * `listHistoryDTO`'s actor hydration) instead of being carried by a join —
   * so no PII (email) or full profile row is ever pulled by this query, only
   * `member_verifications` columns.
   */
  async listForAdmin(
    filter: AdminVerificationListFilter = {},
  ): Promise<AdminVerificationListDTO> {
    const sort = filter.sort ?? 'recent';
    const trimmedQuery = filter.query?.trim();

    const queryBuilder = this.repo.createQueryBuilder('member_verification');

    if (filter.level) {
      queryBuilder.andWhere('member_verification.level = :level', {
        level: filter.level,
      });
    }
    if (trimmedQuery) {
      queryBuilder.andWhere(
        `(
          EXISTS (
            SELECT 1 FROM "profiles" "search_profile"
            WHERE "search_profile"."user_id" = member_verification.user_id
              AND (
                "search_profile"."first_name" ILIKE :searchPattern
                OR "search_profile"."last_name" ILIKE :searchPattern
                OR "search_profile"."slug" ILIKE :searchPattern
              )
          )
          OR EXISTS (
            SELECT 1 FROM "users" "search_user"
            WHERE "search_user"."id" = member_verification.user_id
              AND "search_user"."email" ILIKE :searchPattern
          )
        )`,
        { searchPattern: `%${escapeLikeTerm(trimmedQuery)}%` },
      );
    }

    const { rows, nextCursor } = await cursorPaginate(
      queryBuilder,
      filter.cursor,
      ADMIN_VERIFICATION_PAGE_SIZE,
      'member_verification',
      false, // ignored — an explicit keyset is always supplied below
      this.adminListKeyset(sort),
    );

    // Counts + member-ref hydration run in parallel — independent reads, no
    // reason to serialize them. Hydration is ONE batched lookup over the
    // page's distinct userIds (mirrors `listHistoryDTO`'s actor hydration),
    // not a lookup per row, so this stays O(1) queries per page.
    const [counts, members] = await Promise.all([
      this.countsByLevel(trimmedQuery),
      new MemberLookup(this.profiles).byUserIds([
        ...new Set(rows.map((row) => row.userId)),
      ]),
    ]);

    return {
      rows: rows.map((row) =>
        toAdminVerificationDTO(row, members.get(row.userId) ?? null),
      ),
      counts,
      nextCursor,
    };
  }

  /** The `CursorKeyset` `listForAdmin` seeks on, one per `sort` value. */
  private adminListKeyset(
    sort: AdminVerificationSort,
  ): CursorKeyset<MemberVerification> {
    if (sort === 'level') {
      return {
        columnExpr: LEVEL_RANK_CASE_EXPRESSION,
        // Highest assurance first. Ties (same level) break on `id`, not
        // `updatedAt` — `CursorKeyset` supports exactly one leading column
        // plus the `id` tie-breaker, and the brief doesn't ask for a second
        // ordering dimension inside a level, so this stays within that
        // shape rather than reaching for a 3-column keyset.
        direction: 'DESC',
        kind: 'number',
        getValue: (row) => levelRank(row.level),
      };
    }
    return {
      // CORRECTNESS: wrapped in `date_trunc('milliseconds', …)` for the same
      // reason `cursorPaginate`'s own default (createdAt) path does — see
      // that function's doc comment. `member_verifications.updated_at` is a
      // plain `timestamptz` (not narrowed to `timestamptz(3)`), and the
      // ORIGINAL migration seeded every row's `updated_at` from the
      // database's own `now()` default (not a TypeORM-written JS `Date`), so
      // stored values can carry sub-millisecond precision the cursor (built
      // from a JS `Date`, millisecond resolution) can't represent. Without
      // the wrapper, a row sharing the cursor's millisecond but with nonzero
      // microseconds could compare the wrong side of the seek predicate and
      // be silently skipped. Trade-off: `date_trunc` is STABLE, not
      // IMMUTABLE, so this can't use a plain index on `updated_at` and
      // degrades to a scan+sort — acceptable at this console's scale;
      // narrowing the column to `timestamptz(3)` (as `NarrowCursorCreatedAtPrecision`
      // did for `CommunityPost`/`ForumThread`/`Event`) would remove the need
      // for this wrapper if the roster ever grows large enough to matter.
      columnExpr: `date_trunc('milliseconds', "member_verification"."updated_at")`,
      direction: sort === 'oldest' ? 'ASC' : 'DESC',
      kind: 'date',
      getValue: (row) => row.updatedAt,
    };
  }

  /** `COUNT(*) ... GROUP BY level`, zero-filled for every `VerificationLevel`
   * — the admin console's per-tab counts. Narrows together with the same
   * search term the list uses, but NEVER with the `level` filter itself
   * (every tab needs its own count, not just the currently active one). */
  private async countsByLevel(
    query?: string,
  ): Promise<Record<VerificationLevel, number>> {
    const queryBuilder = this.repo
      .createQueryBuilder('member_verification')
      .select('member_verification.level', 'level')
      .addSelect('COUNT(*)', 'count')
      .groupBy('member_verification.level');

    if (query) {
      queryBuilder
        .leftJoin(
          Profile,
          'profile',
          'profile.userId = member_verification.userId',
        )
        .leftJoin(
          User,
          'search_user',
          'search_user.id = member_verification.userId',
        )
        .andWhere(
          '(profile.firstName ILIKE :searchPattern OR profile.lastName ILIKE :searchPattern OR profile.slug ILIKE :searchPattern OR search_user.email ILIKE :searchPattern)',
          { searchPattern: `%${escapeLikeTerm(query)}%` },
        );
    }

    const rows = await queryBuilder.getRawMany<{
      level: VerificationLevel;
      count: string;
    }>();
    const counts = Object.fromEntries(
      VERIFICATION_LEVEL_ORDER.map((level) => [level, 0]),
    ) as Record<VerificationLevel, number>;
    for (const row of rows) counts[row.level] = Number(row.count);
    return counts;
  }

  /** Hydrates ONE member ref. Used by the admin controller to hand-map the
   * PATCH response — `override` (below) returns the raw entity, not a DTO,
   * so the controller re-loads the ref itself rather than this service
   * reaching back into the HTTP layer's response shape. */
  async getMemberRef(userId: string): Promise<MemberRef | null> {
    const members = await new MemberLookup(this.profiles).byUserIds([userId]);
    return members.get(userId) ?? null;
  }

  /**
   * Manual override — the stub path for granting or revoking a level after a
   * human review. Sets the level DIRECTLY (may lower it), recorded as a
   * `manual_review`/`admin` provenance so the badge never claims a provider
   * check that did not happen, plus reviewer attribution (`reviewedByUserId`,
   * `grantedBy = AdminGranted`) and an append-only `VerificationEvent` so the
   * admin drawer's history panel can show who changed what, and why.
   *
   * Lowering a member's level REQUIRES a `reason` — raising or holding it
   * steady does not. The subject member is notified of the change (skipped on
   * a no-op override that leaves the level unchanged).
   */
  async override(
    userId: string,
    level: VerificationLevel,
    actorUserId: string,
    reason?: string,
  ): Promise<MemberVerification> {
    // Peeked BEFORE any write so the "downgrade needs a reason" guard can
    // throw without touching the row — `grantLevel` re-reads the row itself
    // (see its doc comment for why that duplicate read is fine here).
    const currentLevel = await this.levelForUser(userId);
    const isDowngrade = levelRank(level) < levelRank(currentLevel);
    if (isDowngrade && !reason) {
      throw new BadRequestException(
        "A reason is required to lower a member's verification level",
      );
    }

    const { row } = await this.grantLevel(userId, level, actorUserId, {
      action: isDowngrade
        ? VerificationEventAction.Downgraded
        : VerificationEventAction.Overridden,
      reason: reason ?? null,
    });
    return row;
  }

  /** Newest-first audit trail for a member's verification standing, behind
   * the admin drawer's history panel. */
  async listHistory(userId: string): Promise<VerificationEvent[]> {
    return this.eventRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * `listHistory`, mapped to the wire DTO with `actor` hydrated — the
   * `GET /admin/verifications/:userId/history` payload. Actor hydration is
   * ONE batched `MemberLookup.byUserIds` call over every DISTINCT
   * `actorUserId` on the page, not a lookup per event, so this stays O(1)
   * queries regardless of how long a member's audit trail is.
   */
  async listHistoryDTO(userId: string): Promise<VerificationEventDTO[]> {
    const events = await this.listHistory(userId);
    if (!events.length) return [];

    const actorUserIds = [
      ...new Set(
        events
          .map((event) => event.actorUserId)
          .filter((actorUserId): actorUserId is string => actorUserId !== null),
      ),
    ];
    const actors = await new MemberLookup(this.profiles).byUserIds(
      actorUserIds,
    );

    return events.map((event) =>
      toVerificationEventDTO(
        event,
        event.actorUserId ? (actors.get(event.actorUserId) ?? null) : null,
      ),
    );
  }

  /**
   * Counted/searchable/sorted/paginated request rows for the admin request
   * queue — the `GET /admin/verifications/requests` payload: rows, per-status
   * tab counts, and a keyset cursor for "load more".
   *
   * JOIN-FREE for the exact reason `listForAdmin` is (see that method's doc
   * comment) — this mirrors it precisely rather than inventing a new
   * pattern: the member-search filter is a correlated `EXISTS` against
   * `profiles`/`users`, never a `leftJoin`, so `.take()`/`.skip()` never sees
   * `joinAttributes.length > 0` and TypeORM never falls into its
   * "distinct pagination" two-query path that can't resolve a raw-SQL
   * keyset expression's `.` as `alias.column`. Member refs are hydrated
   * afterward via ONE batched `MemberLookup.byUserIds` call over the page's
   * distinct `userId`s, not a lookup per row.
   */
  async listRequestsForAdmin(
    filter: AdminVerificationRequestListFilter = {},
  ): Promise<AdminVerificationRequestListDTO> {
    const sort = filter.sort ?? 'recent';
    const trimmedQuery = filter.query?.trim();

    const queryBuilder = this.requestRepo.createQueryBuilder(
      'verification_request',
    );

    if (filter.status) {
      queryBuilder.andWhere('verification_request.status = :status', {
        status: filter.status,
      });
    }
    if (filter.type) {
      queryBuilder.andWhere('verification_request.type = :type', {
        type: filter.type,
      });
    }
    if (trimmedQuery) {
      queryBuilder.andWhere(
        `(
          EXISTS (
            SELECT 1 FROM "profiles" "search_profile"
            WHERE "search_profile"."user_id" = verification_request.user_id
              AND (
                "search_profile"."first_name" ILIKE :searchPattern
                OR "search_profile"."last_name" ILIKE :searchPattern
                OR "search_profile"."slug" ILIKE :searchPattern
              )
          )
          OR EXISTS (
            SELECT 1 FROM "users" "search_user"
            WHERE "search_user"."id" = verification_request.user_id
              AND "search_user"."email" ILIKE :searchPattern
          )
        )`,
        { searchPattern: `%${escapeLikeTerm(trimmedQuery)}%` },
      );
    }

    const { rows, nextCursor } = await cursorPaginate(
      queryBuilder,
      filter.cursor,
      ADMIN_VERIFICATION_REQUEST_PAGE_SIZE,
      'verification_request',
      false, // ignored — an explicit keyset is always supplied below
      this.requestListKeyset(sort),
    );

    // Counts + member-ref hydration run in parallel — independent reads, no
    // reason to serialize them. Hydration is ONE batched lookup over the
    // page's distinct userIds, not a lookup per row.
    const [counts, members] = await Promise.all([
      this.countsByRequestStatus(filter.type, trimmedQuery),
      new MemberLookup(this.profiles).byUserIds([
        ...new Set(rows.map((row) => row.userId)),
      ]),
    ]);

    return {
      rows: rows.map((row) =>
        toAdminVerificationRequestDTO(row, members.get(row.userId) ?? null),
      ),
      counts,
      nextCursor,
    };
  }

  /** The `CursorKeyset` `listRequestsForAdmin` seeks on. Unlike
   * `adminListKeyset` (which orders the level console by `updated_at`), a
   * triage queue orders by SUBMISSION date (`created_at`) — when a request
   * moved `in_review` isn't what "oldest first" should mean here. Wrapped in
   * `date_trunc('milliseconds', …)` for the same sub-millisecond-precision
   * reason `cursorPaginate`'s own default path is (see that function's doc
   * comment) — `verification_requests.created_at` is a plain `timestamptz`,
   * not narrowed to `timestamptz(3)`. */
  private requestListKeyset(
    sort: VerificationRequestSort,
  ): CursorKeyset<VerificationRequest> {
    return {
      columnExpr: `date_trunc('milliseconds', "verification_request"."created_at")`,
      direction: sort === 'oldest' ? 'ASC' : 'DESC',
      kind: 'date',
      getValue: (row) => row.createdAt,
    };
  }

  /** `COUNT(*) ... GROUP BY status`, zero-filled for every
   * `VerificationRequestStatus` — the request queue's per-tab counts.
   * Narrows together with the same `type`/search term the list uses, but
   * NEVER with the `status` filter itself (every tab needs its own count,
   * not just the currently active one) — mirrors `countsByLevel`. */
  private async countsByRequestStatus(
    type?: VerificationType,
    query?: string,
  ): Promise<Record<VerificationRequestStatus, number>> {
    const queryBuilder = this.requestRepo
      .createQueryBuilder('verification_request')
      .select('verification_request.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('verification_request.status');

    if (type) {
      queryBuilder.andWhere('verification_request.type = :type', { type });
    }

    if (query) {
      queryBuilder
        .leftJoin(
          Profile,
          'profile',
          'profile.userId = verification_request.userId',
        )
        .leftJoin(
          User,
          'search_user',
          'search_user.id = verification_request.userId',
        )
        .andWhere(
          '(profile.firstName ILIKE :searchPattern OR profile.lastName ILIKE :searchPattern OR profile.slug ILIKE :searchPattern OR search_user.email ILIKE :searchPattern)',
          { searchPattern: `%${escapeLikeTerm(query)}%` },
        );
    }

    const rows = await queryBuilder.getRawMany<{
      status: VerificationRequestStatus;
      count: string;
    }>();
    const counts = Object.fromEntries(
      Object.values(VerificationRequestStatus).map((status) => [status, 0]),
    ) as Record<VerificationRequestStatus, number>;
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  /**
   * `GET /admin/verifications/requests/:id` — the request in full: the list
   * row's fields plus context/evidence/signals/decision, the reviewer's
   * member ref (if any), and the member's FULL verification audit trail
   * (reuses `listHistoryDTO`, not filtered to this one request — a reviewer
   * benefits from seeing prior overrides/requests too). Member + reviewer
   * refs are hydrated in ONE batched `MemberLookup` call.
   */
  async requestDetailDTO(
    id: string,
  ): Promise<AdminVerificationRequestDetailDTO> {
    const request = await this.requestRepo.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('Verification request not found');
    }

    const refUserIds = [request.userId];
    if (request.reviewedByUserId) refUserIds.push(request.reviewedByUserId);

    const [members, history] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds([...new Set(refUserIds)]),
      this.listHistoryDTO(request.userId),
    ]);

    return toAdminVerificationRequestDetailDTO(
      request,
      members.get(request.userId) ?? null,
      request.reviewedByUserId
        ? (members.get(request.reviewedByUserId) ?? null)
        : null,
      history,
    );
  }

  // --- member request lifecycle (Task 3) ---

  /**
   * A member's own newest request for `type` (default `identity`) — backs
   * `GET /verification/me`'s `latestRequest` so the member can see where
   * their request stands without a separate admin-console-style query.
   */
  async latestRequestFor(
    userId: string,
    type: VerificationType = VerificationType.Identity,
  ): Promise<VerificationRequest | null> {
    return this.requestRepo.findOne({
      where: { userId, type },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Anti-fraud evidence for a review decision — computed fresh (never
   * cached) and snapshotted onto `VerificationRequest.signals` (jsonb, no
   * migration needed) by `submitRequest` (at creation) and `decideRequest`
   * (refreshed, so a reviewer always sees CURRENT signals, not whatever was
   * true days ago at submission).
   *
   * DEFERRED (not computed here): phone/VOIP-carrier and IP/geo signals.
   * There is no separately stored member phone number — it lives entirely
   * behind `PhoneVerificationProvider` (see `MemberVerification`'s doc
   * comment) — and this platform captures no IP/geo data anywhere, so there
   * is nothing server-side to compute those from yet. `duplicateProviderRef`
   * is therefore the only cross-account signal available today.
   *
   * The three reads (user, prior-rejection count, this member's own
   * verification row) run in parallel — independent lookups, no reason to
   * serialize them. `duplicateProviderRef` is a SECOND query, but only when
   * the member actually has a non-null `providerRef` to check, and it is
   * ONE grouped query over every other row sharing that ref — never a
   * per-row lookup.
   */
  async computeSignals(
    userId: string,
    type: VerificationType = VerificationType.Identity,
  ): Promise<VerificationSignalsDTO> {
    const [user, priorRejections, verification] = await Promise.all([
      this.userRepo.findOne({ where: { id: userId } }),
      this.requestRepo.count({
        where: { userId, type, status: VerificationRequestStatus.Rejected },
      }),
      this.repo.findOne({ where: { userId, type } }),
    ]);

    const accountAgeDays = user
      ? wholeDaysBetween(user.createdAt, new Date())
      : 0;

    let duplicateProviderRef: VerificationSignalsDTO['duplicateProviderRef'] =
      null;
    const providerRef = verification?.providerRef ?? null;
    if (providerRef) {
      const duplicateRows = await this.repo
        .createQueryBuilder('member_verification')
        .select('member_verification.userId', 'userId')
        .where('member_verification.providerRef = :providerRef', {
          providerRef,
        })
        .andWhere('member_verification.type = :type', { type })
        .andWhere('member_verification.userId != :userId', { userId })
        .getRawMany<{ userId: string }>();
      if (duplicateRows.length > 0) {
        duplicateProviderRef = {
          count: duplicateRows.length,
          userIds: duplicateRows.map((row) => row.userId),
        };
      }
    }

    return { accountAgeDays, priorRejections, duplicateProviderRef };
  }

  /**
   * Member-initiated: opens a new review request. Rejects (409) when the
   * member already has an OPEN request (`pending`/`in_review`/`appealing`)
   * for the same `(userId, type)` — one live request at a time, mirroring
   * the partial index the requests table carries for exactly this check.
   */
  async submitRequest(
    userId: string,
    input: SubmitVerificationRequestInput,
  ): Promise<VerificationRequest> {
    const type = input.type ?? VerificationType.Identity;

    const openRequest = await this.requestRepo.findOne({
      where: { userId, type, status: In(OPEN_REQUEST_STATUSES) },
    });
    if (openRequest) {
      throw new ConflictException(
        'A verification request is already open for this member',
      );
    }

    // Snapshotted at creation — `computeSignals` runs before the request
    // exists, so `priorRejections` never double-counts a request that's
    // about to be created.
    const signals = await this.computeSignals(userId, type);

    const request = await this.requestRepo.save(
      this.requestRepo.create({
        userId,
        type,
        requestedLevel: input.requestedLevel,
        status: VerificationRequestStatus.Pending,
        context: input.context ?? null,
        evidenceRef: input.evidenceRef ?? null,
        // Entity column is the generic jsonb shape (`Record<string,
        // unknown> | null`) — no entity -> DTO coupling; this is the
        // writer that shapes it as `VerificationSignalsDTO`.
        signals: signals as unknown as Record<string, unknown>,
      }),
    );

    await this.writeEvent({
      userId,
      action: VerificationEventAction.Submitted,
      fromLevel: null,
      toLevel: input.requestedLevel,
      actorUserId: userId,
      requestId: request.id,
    });

    return request;
  }

  /**
   * Member-initiated: withdraws their own OPEN request. Owner-only (404 if
   * the request doesn't exist, 403 if it belongs to someone else); legal
   * only from `pending`/`in_review` — `assertTransition` enforces that via
   * `LEGAL_TRANSITIONS` (409 otherwise), so this needs no separate status
   * check of its own.
   */
  async withdrawRequest(
    userId: string,
    requestId: string,
  ): Promise<VerificationRequest> {
    const request = await this.loadOwnedRequest(userId, requestId);
    this.assertTransition(request.status, VerificationRequestStatus.Withdrawn);

    request.status = VerificationRequestStatus.Withdrawn;
    const saved = await this.requestRepo.save(request);

    await this.writeEvent({
      userId,
      action: VerificationEventAction.Withdrawn,
      fromLevel: null,
      toLevel: null,
      actorUserId: userId,
      requestId: request.id,
    });

    return saved;
  }

  /**
   * Member-initiated: appeals a `rejected` request exactly once. Owner-only;
   * `assertTransition` enforces "only from rejected" (409 otherwise); a
   * second appeal on the SAME request row (appeal reuses the row rather than
   * creating a new one, so `isAppeal` stays true across any later
   * rejected→appealing cycle) also 409s.
   */
  async appealRequest(
    userId: string,
    requestId: string,
  ): Promise<VerificationRequest> {
    const request = await this.loadOwnedRequest(userId, requestId);
    this.assertTransition(request.status, VerificationRequestStatus.Appealing);
    if (request.isAppeal) {
      throw new ConflictException(
        'This verification request has already been appealed once',
      );
    }

    request.isAppeal = true;
    request.status = VerificationRequestStatus.Appealing;
    const saved = await this.requestRepo.save(request);

    await this.writeEvent({
      userId,
      action: VerificationEventAction.Appealed,
      fromLevel: null,
      toLevel: null,
      actorUserId: userId,
      requestId: request.id,
    });

    return saved;
  }

  /**
   * Moderator-initiated: the one entry point that moves a request through
   * the review loop. `action` maps 1:1 to a target status
   * (`targetStatusForAction`); the move is validated against
   * `LEGAL_TRANSITIONS` (409 when illegal) before anything else runs.
   *
   * `approve` raises the member's level via `grantLevel` — the SAME helper
   * `override` delegates to — so it writes exactly ONE `Approved` event
   * (never an `Overridden`) carrying this request's id. `reject` requires a
   * `reason` (400 without one) and writes a `Rejected` event directly (no
   * level change, so it doesn't go through `grantLevel`). `in_review` only
   * moves the status — no level event, no notification.
   */
  async decideRequest(
    requestId: string,
    actorUserId: string,
    action: VerificationRequestDecisionAction,
    reason?: string,
  ): Promise<VerificationRequest> {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException('Verification request not found');
    }

    const targetStatus = this.targetStatusForAction(action);
    this.assertTransition(request.status, targetStatus);

    if (action === 'reject' && !reason) {
      throw new BadRequestException(
        'A reason is required to reject a verification request',
      );
    }

    // Refreshed (not reused from submission) so a reviewer's decision is
    // informed by CURRENT signals — an account that looked clean at
    // submission may since have picked up a duplicate `providerRef` or a
    // prior rejection on another request. Computed before the status
    // branches below mutate `request`, so `priorRejections` still reflects
    // history up to (not including) THIS decision.
    request.signals = (await this.computeSignals(
      request.userId,
      request.type,
    )) as unknown as Record<string, unknown>;

    if (action === 'approve') {
      const decisionNotifyPayload = {
        requestedLevel: request.requestedLevel,
        decision: 'approved' as const,
      };
      // Distinct from `grantLevel`'s default {fromLevel,toLevel} shape (which
      // `override` keeps): the member reads this as "your request was
      // decided", not as a raw ladder move.
      const { changed } = await this.grantLevel(
        request.userId,
        request.requestedLevel,
        actorUserId,
        {
          action: VerificationEventAction.Approved,
          reason: reason ?? null,
          requestId: request.id,
          notifyPayload: decisionNotifyPayload,
        },
      );
      request.status = VerificationRequestStatus.Approved;
      request.reviewedByUserId = actorUserId;
      request.decisionReason = reason ?? null;
      const saved = await this.requestRepo.save(request);

      // A member who submits a request deserves to hear the outcome even
      // when the approved level happens to equal their CURRENT level (a
      // no-op raise) — `grantLevel` skips its own notification in that case
      // (same no-op-skip `override` relies on), so send the decision
      // notification here instead. When the level DID change, `grantLevel`
      // already sent it — never double-notify.
      if (!changed) {
        await this.notifications.create(
          request.userId,
          NotificationType.VerificationUpdate,
          decisionNotifyPayload,
        );
      }

      return saved;
    }

    if (action === 'reject') {
      request.status = VerificationRequestStatus.Rejected;
      request.reviewedByUserId = actorUserId;
      request.decisionReason = reason ?? null;
      const saved = await this.requestRepo.save(request);

      await this.writeEvent({
        userId: request.userId,
        action: VerificationEventAction.Rejected,
        fromLevel: null,
        toLevel: null,
        actorUserId,
        reason: reason ?? null,
        requestId: request.id,
      });

      await this.notifications.create(
        request.userId,
        NotificationType.VerificationUpdate,
        {
          requestedLevel: request.requestedLevel,
          decision: 'rejected' as const,
          reason,
        },
      );

      return saved;
    }

    // action === 'in_review' — status only, no level event, no notification.
    request.status = VerificationRequestStatus.InReview;
    request.reviewedByUserId = actorUserId;
    return this.requestRepo.save(request);
  }

  /**
   * Moderator-initiated: applies ONE decision to MANY requests — the
   * `POST /admin/verifications/requests/bulk` payload. Genuinely BATCHED
   * (no longer a loop of `decideRequest`, one transaction per id): ONE
   * `find(... In(ids))` load, partition in memory against
   * `LEGAL_TRANSITIONS` (this is what preserves partial success — an id
   * that's missing, or whose current status can't legally reach the target
   * status, lands in `failed` with the same message `decideRequest` would
   * have thrown, WITHOUT touching the DB), then ONE transaction
   * (`applyBulkDecision`) that bulk-writes every valid request's new
   * status, its `VerificationEvent`s, and — approve only — the affected
   * `member_verifications` rows. `reject` still requires a `reason`,
   * validated ONCE up front (a single 400 for the whole call, before any id
   * is touched) — mirrors `decideRequest`'s own up-front check. The batch
   * size is bounded at the DTO layer (`@ArrayMaxSize(BULK_ACTION_CAP)`), not
   * re-checked here.
   *
   * Side-effect parity with `decideRequest` is deliberate and exact for
   * every valid id: approve raises the member's level (the SAME stamping
   * `grantLevel` applies, via the shared `stampManualGrant` helper so the
   * two mechanics can never drift) and writes exactly ONE `Approved` event
   * carrying the request id; reject sets status/decisionReason and writes
   * ONE `Rejected` event carrying the reason; `in_review` only moves the
   * status (no event, no notification). The one DELIBERATE difference from
   * `decideRequest`: signals are NOT recomputed here — a bulk decision
   * keeps each request's as-of-submission `signals` snapshot rather than
   * paying a `computeSignals` round-trip (a user read + a priorRejections
   * count + a possible duplicate-providerRef query) per request, which
   * would put the exact N+1 problem this refactor exists to remove right
   * back into the "batched" path. A single decision through `decideRequest`
   * still refreshes signals as before.
   *
   * Mirrors `ListingsService.bulkSetStatus`/`bulkRemove`'s
   * skip-invalid/report-failed shape and adopts the same whole-transaction
   * failure behavior: a per-id problem (not found, illegal transition) is
   * business validation, partitioned out BEFORE the transaction ever opens,
   * so it never touches the DB; a genuine DB error once the transaction is
   * running instead propagates out of `bulkDecide` (rolling back everything
   * written so far) rather than being caught and silently downgraded into
   * `failed` entries — the repo's established bulk-write norm, and it keeps
   * "some of the batch silently didn't happen" from ever being reported as
   * a 200.
   */
  async bulkDecide(
    ids: string[],
    actorUserId: string,
    action: VerificationRequestDecisionAction,
    reason?: string,
  ): Promise<BulkDecideVerificationRequestsResultDTO> {
    if (action === 'reject' && !reason) {
      throw new BadRequestException(
        'A reason is required to reject a verification request',
      );
    }

    const uniqueIds = [...new Set(ids)];
    const targetStatus = this.targetStatusForAction(action);

    // ONE load for the whole batch, instead of one `findOne` per id.
    const found = await this.requestRepo.find({
      where: { id: In(uniqueIds) },
    });
    const requestById = new Map(found.map((request) => [request.id, request]));

    // Partition in memory — an id not found, or whose current status can't
    // legally reach `targetStatus`, is reported in `failed` (the same
    // message `decideRequest`/`assertTransition` would have thrown for that
    // one id) and never enters the transaction below.
    const failed: { id: string; reason: string }[] = [];
    const valid: VerificationRequest[] = [];
    for (const id of uniqueIds) {
      const request = requestById.get(id);
      if (!request) {
        failed.push({ id, reason: 'Verification request not found' });
        continue;
      }
      if (!LEGAL_TRANSITIONS[request.status].includes(targetStatus)) {
        failed.push({
          id,
          reason: `Cannot move a verification request from "${request.status}" to "${targetStatus}"`,
        });
        continue;
      }
      valid.push(request);
    }

    let succeededRequests: VerificationRequest[] = [];
    if (valid.length) {
      succeededRequests = await this.requestRepo.manager.transaction(
        (txManager) =>
          this.applyBulkDecision(
            txManager,
            valid,
            actorUserId,
            action,
            targetStatus,
            reason,
          ),
      );
    }

    // Notifications run AFTER commit — never notify on a change that got
    // rolled back — and stay a per-recipient loop: notifications are
    // inherently per-recipient (`NotificationsService` has no
    // batched-per-recipient-payload API), so this is not the round-trip
    // problem this refactor targets.
    await this.notifyBulkDecision(succeededRequests, action, reason);

    const succeededIds = new Set(
      succeededRequests.map((request) => request.id),
    );
    const succeeded = uniqueIds.filter((id) => succeededIds.has(id));

    return { succeeded, failed };
  }

  /**
   * `bulkDecide`'s transactional core. `requests` are already known-legal
   * (partitioned by the caller) — this mutates them in place and writes the
   * whole batch in as few statements as the shape allows: one bulk
   * `member_verifications` load (approve only), one bulk
   * `VerificationEvent` insert, one bulk `member_verifications` save
   * (approve only), one bulk `VerificationRequest` save. Runs entirely
   * against `txManager` — never the instance repos — so every write in the
   * batch commits, or rolls back, together.
   */
  private async applyBulkDecision(
    txManager: EntityManager,
    requests: VerificationRequest[],
    actorUserId: string,
    action: VerificationRequestDecisionAction,
    targetStatus: VerificationRequestStatus,
    reason?: string,
  ): Promise<VerificationRequest[]> {
    const events: {
      userId: string;
      action: VerificationEventAction;
      fromLevel: VerificationLevel | null;
      toLevel: VerificationLevel | null;
      actorUserId: string;
      reason: string | null;
      requestId: string;
    }[] = [];
    let memberRows: MemberVerification[] = [];

    if (action === 'approve') {
      // ONE query for every distinct member behind this batch, instead of
      // `loadOrCreate`'s one-`findOne`-per-id.
      const userIds = [...new Set(requests.map((request) => request.userId))];
      const existing = await txManager.find(MemberVerification, {
        where: { userId: In(userIds) },
      });
      const rowByUserId = new Map(existing.map((row) => [row.userId, row]));

      for (const request of requests) {
        let row = rowByUserId.get(request.userId);
        if (!row) {
          row = txManager.create(MemberVerification, {
            userId: request.userId,
            level: VerificationLevel.Email,
          });
          rowByUserId.set(request.userId, row);
        }
        // Same stamping `grantLevel` applies — shared helper, not a
        // reimplementation. Two requests for the SAME member in one batch
        // (edge case) stack correctly: the second's `fromLevel` reads the
        // first's already-mutated `row.level`, exactly like two sequential
        // `decideRequest` calls would see each other's committed write.
        const fromLevel = this.stampManualGrant(
          row,
          request.requestedLevel,
          actorUserId,
        );
        events.push({
          userId: request.userId,
          action: VerificationEventAction.Approved,
          fromLevel,
          toLevel: request.requestedLevel,
          actorUserId,
          reason: reason ?? null,
          requestId: request.id,
        });
      }
      memberRows = [...rowByUserId.values()];
    } else if (action === 'reject') {
      for (const request of requests) {
        events.push({
          userId: request.userId,
          action: VerificationEventAction.Rejected,
          fromLevel: null,
          toLevel: null,
          actorUserId,
          reason: reason ?? null,
          requestId: request.id,
        });
      }
    }
    // action === 'in_review' writes no event — mirrors `decideRequest`.

    for (const request of requests) {
      request.status = targetStatus;
      request.reviewedByUserId = actorUserId;
      // `decideRequest`'s `in_review` branch never touches `decisionReason`
      // — only approve/reject do.
      if (action !== 'in_review') {
        request.decisionReason = reason ?? null;
      }
    }

    if (events.length) {
      await txManager.insert(VerificationEvent, events);
    }
    if (memberRows.length) {
      await txManager.save(memberRows);
    }
    await txManager.save(requests);

    return requests;
  }

  /**
   * `bulkDecide`'s post-commit notification pass — one `notifications.create`
   * per succeeded request, run only once the transaction has committed (so a
   * rolled-back write never fires a notification for a change that didn't
   * happen). Payload shape matches `decideRequest`'s exactly per action:
   * approve carries `{requestedLevel, decision: 'approved'}` UNCONDITIONALLY
   * (mirrors `decideRequest`, which sends this exact payload exactly once
   * either way — via `grantLevel` when the level actually changed, or
   * directly when it was a no-op raise — so a bulk-approved member always
   * hears the outcome exactly once too); reject carries the same shape plus
   * `reason`; `in_review` sends nothing.
   *
   * Each `notifications.create` call is individually try/caught. By the time
   * this runs, every DB write for the batch has already committed and can't
   * be rolled back — so a notification-layer failure for one recipient (e.g.
   * a transient error inside `create`'s block/mute/preference lookups) must
   * be logged and skipped, never allowed to propagate. An uncaught throw
   * here would abort the loop (silently dropping every notification after
   * the one that failed) AND escape `bulkDecide` entirely, turning an
   * already-committed, partially-successful batch into a bare 500 with no
   * `{succeeded, failed}` body at all — the exact partial-success guarantee
   * this endpoint exists to provide.
   */
  private async notifyBulkDecision(
    requests: VerificationRequest[],
    action: VerificationRequestDecisionAction,
    reason?: string,
  ): Promise<void> {
    if (action === 'in_review') return;
    for (const request of requests) {
      const payload =
        action === 'approve'
          ? {
              requestedLevel: request.requestedLevel,
              decision: 'approved' as const,
            }
          : {
              requestedLevel: request.requestedLevel,
              decision: 'rejected' as const,
              reason,
            };
      try {
        await this.notifications.create(
          request.userId,
          NotificationType.VerificationUpdate,
          payload,
        );
      } catch (error) {
        this.logger.error(
          `bulkDecide: failed to notify user ${request.userId} of request ${request.id}'s decision — the decision itself is already committed`,
          error instanceof Error ? error.stack : error,
        );
      }
    }
  }

  // --- internals ---

  /** Persists one append-only audit row. The single write path every
   * verification-standing change goes through — `override`/`grantLevel` and
   * every request-lifecycle action (submit/approve/reject/appeal/withdraw)
   * that share the same `verification_events` table. `requestId` links an
   * event back to the request that caused it (null for the non-request
   * `override` path). */
  private async writeEvent(event: {
    userId: string;
    action: VerificationEventAction;
    fromLevel: VerificationLevel | null;
    toLevel: VerificationLevel | null;
    actorUserId: string | null;
    reason?: string | null;
    signals?: Record<string, unknown> | null;
    requestId?: string | null;
  }): Promise<VerificationEvent> {
    return this.eventRepo.save(
      this.eventRepo.create({
        userId: event.userId,
        action: event.action,
        fromLevel: event.fromLevel,
        toLevel: event.toLevel,
        actorUserId: event.actorUserId,
        reason: event.reason ?? null,
        signals: event.signals ?? null,
        requestId: event.requestId ?? null,
      }),
    );
  }

  /**
   * The stamping logic of a manual-review grant — sets the level DIRECTLY
   * and stamps reviewer attribution (`method`, `provider`, `providerRef`,
   * `verifiedAt`, `reviewedByUserId`, `grantedBy`). Mutates `row` in place
   * and returns the level it moved FROM (read before the mutation) so the
   * caller can tell whether anything actually changed without a second read.
   * Extracted out of `grantLevel` so `bulkDecide`'s batched approve path
   * (`applyBulkDecision`) can apply the EXACT SAME mechanics against a
   * transactional row it loaded/created itself, without looping
   * `grantLevel` (which would reintroduce a per-id `loadOrCreate` +
   * `repo.save` + `writeEvent` + `notifications.create` round-trip — the
   * very thing this refactor removes). `grantLevel` still owns persisting,
   * auditing, and notifying for the single-decision path; this helper only
   * owns the field mutations both paths must agree on.
   */
  private stampManualGrant(
    row: MemberVerification,
    level: VerificationLevel,
    actorUserId: string,
  ): VerificationLevel {
    const fromLevel = row.level;
    row.level = level;
    row.method = 'manual_review';
    row.provider = 'admin';
    row.providerRef = null;
    row.verifiedAt =
      levelRank(level) > levelRank(VerificationLevel.Email) ? new Date() : null;
    row.reviewedByUserId = actorUserId;
    row.grantedBy = VerificationGrantedBy.AdminGranted;
    return fromLevel;
  }

  /**
   * The single place a member's `member_verifications` row is actually
   * granted a level by a human decision (as opposed to `raiseTo`'s
   * automated step-up path). Sets the level DIRECTLY, stamps reviewer
   * attribution (`reviewedByUserId`, `grantedBy = AdminGranted`), writes
   * exactly ONE `VerificationEvent`, and notifies the member unless the
   * level didn't actually change (no-op grant, still audited above).
   * Returns whether the level actually changed (`changed`) alongside the
   * saved row so a caller that owes the member a notification REGARDLESS of
   * a no-op raise (`decideRequest`'s approve path — see below) knows when it
   * needs to send its own, without a second DB read to re-derive it.
   *
   * Shared by `override` (action `Overridden`/`Downgraded`, no `requestId`,
   * default `{fromLevel,toLevel}` notification, no-op silently skipped — a
   * direct admin override with no request behind it doesn't owe the member
   * anything when nothing changed) and `decideRequest`'s approve path
   * (action `Approved`, `requestId` set, a `{requestedLevel,decision}`
   * notification via `notifyPayload`) so a request approval can NEVER
   * accidentally double as an `Overridden` event — there is exactly one
   * write path, and the caller only chooses the
   * `action`/`reason`/`requestId`/`notifyPayload`, never the mechanics.
   */
  private async grantLevel(
    userId: string,
    level: VerificationLevel,
    actorUserId: string,
    options: {
      action: VerificationEventAction;
      reason?: string | null;
      requestId?: string | null;
      notifyPayload?: Record<string, unknown>;
    },
  ): Promise<{ row: MemberVerification; changed: boolean }> {
    const row = await this.loadOrCreate(userId);
    const fromLevel = this.stampManualGrant(row, level, actorUserId);
    const changed = fromLevel !== level;
    const saved = await this.repo.save(row);

    await this.writeEvent({
      userId,
      action: options.action,
      fromLevel,
      toLevel: level,
      actorUserId,
      reason: options.reason ?? null,
      requestId: options.requestId ?? null,
    });

    // No-op grant (level unchanged) is still audited above, but nothing
    // actually changed for the member, so skip the notification here — the
    // `changed` return value lets a caller that owes a decision notification
    // regardless (approve) send its own instead.
    if (changed) {
      await this.notifications.create(
        userId,
        NotificationType.VerificationUpdate,
        options.notifyPayload ?? { fromLevel, toLevel: level },
      );
    }

    return { row: saved, changed };
  }

  /** Throws `ConflictException` (409) unless `to` is a legal next state from
   * `from` per `LEGAL_TRANSITIONS` — the single place every request-status
   * move (member and moderator alike) is validated. */
  private assertTransition(
    from: VerificationRequestStatus,
    to: VerificationRequestStatus,
  ): void {
    if (!LEGAL_TRANSITIONS[from].includes(to)) {
      throw new ConflictException(
        `Cannot move a verification request from "${from}" to "${to}"`,
      );
    }
  }

  /** `decideRequest`'s action → target status map. */
  private targetStatusForAction(
    action: VerificationRequestDecisionAction,
  ): VerificationRequestStatus {
    switch (action) {
      case 'in_review':
        return VerificationRequestStatus.InReview;
      case 'approve':
        return VerificationRequestStatus.Approved;
      case 'reject':
        return VerificationRequestStatus.Rejected;
    }
  }

  /** Loads a request and enforces member ownership — 404 when the request
   * doesn't exist, 403 when it belongs to someone else. Shared by
   * `withdrawRequest`/`appealRequest`; `decideRequest` (moderator-initiated,
   * no ownership check) loads the request itself instead. */
  private async loadOwnedRequest(
    userId: string,
    requestId: string,
  ): Promise<VerificationRequest> {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException('Verification request not found');
    }
    if (request.userId !== userId) {
      throw new ForbiddenException('You do not own this verification request');
    }
    return request;
  }

  /**
   * Phase 2 (Task 6) dormant-seam gate. Defaults to `false` — manual-first:
   * `verifyPhone`/`handleIdentityCallback` keep recording the real provider
   * event, but only `grantLevel` (via an APPROVED review request) raises the
   * member's level. Set `VERIFICATION_AUTOMATED_ELEVATION=true` to restore
   * the old instant-raise-on-verify behavior.
   */
  private automatedElevationEnabled(): boolean {
    return (
      this.config.get<string>('VERIFICATION_AUTOMATED_ELEVATION') === 'true'
    );
  }

  private async loadOrCreate(userId: string): Promise<MemberVerification> {
    const existing = await this.repo.findOne({ where: { userId } });
    if (existing) return existing;
    return this.repo.create({ userId, level: VerificationLevel.Email });
  }

  /** Raise a member to `level` if it is above their current one; never lowers. */
  private async raiseTo(
    userId: string,
    level: VerificationLevel,
    method: string,
    provider: string,
  ): Promise<void> {
    const row = await this.loadOrCreate(userId);
    if (levelRank(level) <= levelRank(row.level)) return;
    row.level = level;
    row.method = method;
    row.provider = provider;
    row.verifiedAt = new Date();
    await this.repo.save(row);
  }
}
