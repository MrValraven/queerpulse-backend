import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  Not,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { toVisibleAvatarUrl } from '../common/member-ref';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import {
  Vouch,
  VOUCH_RELATIONSHIPS,
  type VouchRelationship,
} from './entities/vouch.entity';
import { VOUCH_CREATED, VouchCreatedEvent } from './vouch.events';

// Bounds an otherwise-unbounded list read; callers may narrow with limit/offset.
const DEFAULT_PAGE_SIZE = 20;

// How many of a member's newest named vouchers `getNamedVoucherIds` will scan.
// Bounds the `IN (...)` list the viewer-relative mutual-voucher intersection
// builds from it, so one very heavily vouched member can never turn a profile
// read into an unbounded query. See that method for what the cap means.
const NAMED_VOUCHER_SCAN_CAP = 500;

// Caps how many *new* vouches a single member can give in a day (COM-26):
// vouching has only ever had a per-minute throttle
// (`vouch.controller.ts`'s `@Throttle`), which stops rapid-fire bursts but not
// a member steadily vouching for hundreds of people over weeks — that dilutes
// vouching as a trust signal. This is deliberately generous (a genuine
// community connector vouching for a dozen people they actually know in one
// day is normal); it exists to catch abuse, not to gate everyday use.
const DAILY_VOUCH_LIMIT = 20;

// Start of the current UTC calendar day — the lower bound of the "vouches
// given today" count. UTC (not local) so the reset instant is deterministic
// across deploy regions, same convention as `invites.service.ts`'s monthly
// invite quota.
function currentDayStart(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

const VOUCH_RELATIONSHIP_SET = new Set<VouchRelationship>(VOUCH_RELATIONSHIPS);

/**
 * Canonicalize the caller-supplied "ways you know them": keep only known enum
 * values, drop duplicates (preserving first-seen order), and collapse an empty
 * result to null — the "no relationship recorded" state the column started with.
 */
function normalizeRelationships(
  input: VouchRelationship[] | null | undefined,
): VouchRelationship[] | null {
  if (!input?.length) {
    return null;
  }
  const seen = new Set<VouchRelationship>();
  for (const value of input) {
    if (VOUCH_RELATIONSHIP_SET.has(value)) {
      seen.add(value);
    }
  }
  return seen.size ? [...seen] : null;
}

export interface PageParams {
  limit?: number;
  offset?: number;
}

export interface VoucherView {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  note: string | null;
  createdAt: Date;
  /**
   * True when the voucher chose to vouch anonymously. In that case the identity
   * fields (`slug`/`firstName`/`lastName`/`avatarUrl`) are shielded to empty —
   * anonymity is a safety property, so the voucher's identity is never emitted.
   */
  anonymous: boolean;
  /**
   * The ways the voucher knows this member ("collaborated", "friends", …).
   * Non-identifying, so it is emitted for anonymous vouchers too. Null when the
   * vouch carries no recorded relationship (e.g. the signup auto-vouch).
   */
  relationships: VouchRelationship[] | null;
}

export interface GivenVouchView {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  note: string | null;
  createdAt: Date;
  anonymous: boolean;
  /**
   * The ways the current member knows this vouchee ("collaborated",
   * "friends", …). `listGiven` reuses the same `toVouchView` mapper as
   * `listVouchers`, which always attaches it — declared here too so the
   * interface matches what the endpoint actually returns. Null when the
   * vouch carries no recorded relationship.
   */
  relationships: VouchRelationship[] | null;
}

/**
 * The active vouch relationships between a viewer and a set of other members,
 * split by direction. Powers the connections vouch badge without exposing the
 * `Vouch` entity outside this module.
 */
export interface VouchDirections {
  /** The `otherIds` the viewer currently has an active vouch FOR. */
  youVouched: Set<string>;
  /** The `otherIds` who currently have an active vouch for the viewer. */
  vouchedForYou: Set<string>;
}

@Injectable()
export class VouchService {
  constructor(
    @InjectRepository(Vouch) private readonly vouches: Repository<Vouch>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly blockFilter: BlockFilterService,
  ) {}

  async createVouch(
    voucherId: string,
    voucheeSlug: string,
    input?: {
      note?: string;
      relationships?: VouchRelationship[] | null;
      anonymous?: boolean;
    },
  ): Promise<{ vouchCount: number }> {
    // Resolved through an ACTIVE-user join, not `profiles.findOne({ slug })`.
    // A bare profile lookup happily returned deactivated, suspended, banned and
    // grace-period accounts, so a member could vouch for someone every other
    // surface treats as invisible: it incremented their `vouch_count` and fired
    // a `VOUCH_CREATED` notification at an account that is not supposed to be
    // reachable. Same `u.status = active` join `MemberLookup.userIdsForSlugs`
    // and `ProfilesService.searchMembers` use, so "who can be addressed by
    // slug" means one thing across the app.
    const vouchee = await this.profiles
      .createQueryBuilder('p')
      .innerJoin('p.user', 'u', 'u.status = :active', {
        active: UserStatus.Active,
      })
      .where('p.slug = :slug', { slug: voucheeSlug })
      .getOne();
    if (!vouchee) {
      throw new NotFoundException('Member not found');
    }
    const voucheeId = vouchee.userId;
    if (voucheeId === voucherId) {
      throw new BadRequestException('You cannot vouch for yourself');
    }
    // A block either way severs the possibility of a new vouch, exactly as it
    // severs a connection request (`ConnectionsService.requestConnection`).
    // Without this, someone the member had blocked could still vouch for them,
    // raise their `vouch_count`, fire a `VOUCH_CREATED` notification at them,
    // and put their own face in the member's voucher roster with no way for
    // the member to take it down. Same symmetric check, same 403.
    if (await this.blockFilter.isBlockedEitherWay(voucherId, voucheeId)) {
      throw new ForbiddenException('You cannot vouch for this member');
    }

    // Empty/whitespace-only notes are stored as null, not "".
    const trimmedNote = input?.note?.trim();
    const cleanNote = trimmedNote ? trimmedNote : null;
    // De-dupe (preserving order) and drop anything not in the enum. An empty
    // result stores as null — the "no relationship given" state, same as before.
    const relationships = normalizeRelationships(input?.relationships);
    const anonymous = input?.anonymous ?? false;

    // One row per (voucher, vouchee) ever. If a withdrawn row exists, re-vouching
    // un-withdraws it (keeps id/createdAt) rather than 409-ing. An ACTIVE row is
    // a genuine duplicate.
    const existing = await this.vouches.findOne({
      where: { voucherId, voucheeId },
    });
    if (existing && existing.withdrawnAt === null) {
      throw new ConflictException('You have already vouched for this member');
    }

    // Vouches are a trust/recognition signal ONLY — they no longer gate
    // membership. The threshold-crossing promotion that used to live here died
    // with `UserStatus.Pending`: its target was "a pending account reaching N
    // vouches", and there are no pending accounts. Membership is decided by
    // invite (or by an admin approving a join request), never by accumulation.
    let vouchCount = 0;
    await this.dataSource.transaction(async (manager) => {
      // Lock the voucher's own row so concurrent vouches FROM this member
      // serialize against the daily-cap count below (same pessimistic-lock +
      // count-then-write pattern as `invites.service.ts`'s monthly invite
      // quota). Enforced here — inside the same transaction as the write,
      // never as separate infrastructure like a cron or counter table.
      await manager.findOne(User, {
        where: { id: voucherId },
        lock: { mode: 'pessimistic_write' },
      });
      // Counts `COALESCE(reactivated_at, created_at)`, not `created_at` alone.
      // A re-vouch updates the existing (voucher, vouchee) row in place and
      // keeps its original `created_at`, so counting only `created_at` meant a
      // withdraw-and-re-vouch cycle never touched the cap: once a member had a
      // row for someone, they could re-fire that vouch (and its notification)
      // as often as they liked. `reactivated_at` is stamped below on every
      // reinstatement, which makes a reactivation cost a slot like a first
      // vouch does.
      const givenToday = await manager
        .createQueryBuilder(Vouch, 'v')
        .where('v.voucherId = :voucherId', { voucherId })
        .andWhere('COALESCE(v.reactivatedAt, v.createdAt) >= :dayStart', {
          dayStart: currentDayStart(new Date()),
        })
        .getCount();
      if (givenToday >= DAILY_VOUCH_LIMIT) {
        throw new ForbiddenException(
          `You can vouch for up to ${DAILY_VOUCH_LIMIT} members per day. Try again tomorrow.`,
        );
      }

      // Take a write lock on the vouchee row so concurrent vouches for the
      // same member serialize and `vouchCount` below is read consistently
      // rather than from a racing snapshot. The lock is held to commit.
      await manager.findOne(User, {
        where: { id: voucheeId },
        lock: { mode: 'pessimistic_write' },
      });
      if (existing) {
        // Withdrawn → reactivate in place. CONDITIONAL on the row still being
        // withdrawn: `existing` was read BEFORE the transaction, so two
        // concurrent re-vouches both saw a withdrawn row. An unconditional
        // update let both "reactivate" it and both increment `vouch_count`,
        // leaving the denormalized column permanently one too high with no
        // reconciliation job to catch it. Exactly one claim can now win; the
        // loser is the duplicate it always was.
        const claim = await manager.update(
          Vouch,
          { id: existing.id, withdrawnAt: Not(IsNull()) },
          {
            withdrawnAt: null,
            // Stamped so the daily cap can see this reinstatement; `created_at`
            // stays as it was, since the relationship really did start then.
            reactivatedAt: new Date(),
            note: cleanNote,
            relationships,
            anonymous,
          },
        );
        if (claim.affected !== 1) {
          throw new ConflictException(
            'You have already vouched for this member',
          );
        }
      } else {
        try {
          await manager.insert(Vouch, {
            voucherId,
            voucheeId,
            note: cleanNote,
            relationships,
            anonymous,
          });
        } catch (err) {
          // The pre-check can be lost to a concurrent vouch; the UNIQUE
          // constraint is the real backstop. Map it to a 409, not a 500.
          if (isUniqueViolation(err)) {
            throw new ConflictException(
              'You have already vouched for this member',
            );
          }
          throw err;
        }
      }
      // Keep the denormalized `profiles.vouch_count` in sync (see
      // AddProfileVouchCount1787600100000 / `searchMembers`'s `MostVouched`
      // sort). An atomic `vouch_count = vouch_count + 1`, not a
      // read-then-write, so concurrent vouches for the same member can't
      // clobber each other's increment — same transaction, same pessimistic
      // lock on the vouchee's `User` row taken above.
      await manager.increment(Profile, { userId: voucheeId }, 'vouchCount', 1);
      vouchCount = await manager.count(Vouch, {
        where: { voucheeId, withdrawnAt: IsNull() },
      });
    });
    this.eventEmitter.emit(VOUCH_CREATED, {
      voucherId,
      voucheeId,
    } satisfies VouchCreatedEvent);
    return { vouchCount };
  }

  /**
   * Insert a vouch inside the CALLER'S transaction, addressed by user ids
   * rather than a slug. The signup flow uses this to auto-vouch an inviter for
   * the member they brought in, so the vouch commits or rolls back together
   * with the account creation and invite claim.
   *
   * Deliberately does NOT emit VOUCH_CREATED — an event fired here would survive
   * a rollback of the caller's transaction. The caller emits it after commit
   * (see AuthService), the same way it emits USER_PROMOTED.
   *
   * Returns true when a row was inserted. Skips (returns false) a self-vouch;
   * this can't happen for a brand-new signup, but keeps the helper safe for any
   * caller. No duplicate handling: the target member is created in the same
   * transaction, so no prior (voucher, vouchee) row can exist.
   */
  async createVouchInTransaction(
    manager: EntityManager,
    voucherId: string,
    voucheeId: string,
    note?: string | null,
  ): Promise<boolean> {
    if (voucherId === voucheeId) {
      return false;
    }
    // Empty/whitespace-only notes are stored as null, not "" — same as createVouch.
    const trimmedNote = note?.trim();
    const cleanNote = trimmedNote ? trimmedNote : null;
    await manager.insert(Vouch, { voucherId, voucheeId, note: cleanNote });
    // Same denormalized-counter upkeep as `createVouch` — see the comment
    // there. The vouchee's `Profile` row is guaranteed to already exist in
    // this transaction: the only caller (AuthService's signup flow) creates
    // it earlier in the same manager, before this runs.
    await manager.increment(Profile, { userId: voucheeId }, 'vouchCount', 1);
    return true;
  }

  async withdrawVouch(
    voucherId: string,
    voucheeSlug: string,
  ): Promise<{ ok: true }> {
    const vouchee = await this.profiles.findOne({
      where: { slug: voucheeSlug },
    });
    if (!vouchee) {
      throw new NotFoundException('Member not found');
    }
    // Soft-delete: keep the row (history + admin trust graph) but stamp
    // withdrawnAt so it drops out of every count/list. Only an ACTIVE row can
    // be withdrawn. Withdrawing never demotes — promotion is one-way.
    const active = await this.vouches.findOne({
      where: { voucherId, voucheeId: vouchee.userId, withdrawnAt: IsNull() },
    });
    if (!active) {
      throw new NotFoundException('No vouch to withdraw');
    }
    await this.dataSource.transaction(async (manager) => {
      // CONDITIONAL claim on the row still being active. `active` was read
      // BEFORE the transaction, so a double-click (or two tabs) both saw it
      // live; an unconditional update let both stamp `withdrawnAt` and both
      // decrement, driving `profiles.vouch_count` below the real count.
      // Losing the claim means someone else already withdrew it — idempotent,
      // not an error, so the caller still sees `{ ok: true }`.
      const claim = await manager.update(
        Vouch,
        { id: active.id, withdrawnAt: IsNull() },
        { withdrawnAt: new Date() },
      );
      if (claim.affected !== 1) {
        return;
      }
      // Same denormalized-counter upkeep as `createVouch`, mirrored for the
      // withdraw direction — atomic `vouch_count = vouch_count - 1` in the
      // same transaction as the soft-delete, so the column never drifts from
      // the real active-vouch count.
      await manager.decrement(
        Profile,
        { userId: vouchee.userId },
        'vouchCount',
        1,
      );
    });
    return { ok: true };
  }

  async listVouchers(
    slug: string,
    page?: PageParams,
    // The authenticated caller, when known — used only to decide whether they
    // ARE the target member (see `vouchersVisible` gate below). `undefined`
    // is treated the same as "some other member": never the owner.
    viewerId?: string,
  ): Promise<{ count: number; vouchers: VoucherView[] }> {
    const target = await this.profiles.findOne({ where: { slug } });
    if (!target) {
      throw new NotFoundException('Member not found');
    }
    // `count` is the full tally; `rows` is the requested (bounded) page. Both
    // run through `activeVouchesReceivedBy`, so the number and the roster are
    // filtered identically: a filtered roster beside an unfiltered number is
    // the "no vouches yet, 7 vouches" contradiction this endpoint already has
    // in its `vouchersVisible` branch, and it must not be reproduced here.
    const count = await this.activeVouchesReceivedBy(target.userId).getCount();
    // Names hidden: when the target has turned `vouchersVisible` off, a
    // non-owner viewer still gets the true `count` ("Names hidden — visitors
    // see the number only") but never the roster of who vouched — the owner
    // always sees the real list, same as the photoVisible/hoodVisible content
    // gates in toFullProfile.
    const isOwner = viewerId !== undefined && viewerId === target.userId;
    if (!isOwner && !target.vouchersVisible) {
      return { count, vouchers: [] };
    }
    // `id` tiebreaks `createdAt` so an OFFSET page boundary that lands inside
    // a batch of same-instant vouches can't repeat or skip one.
    const rows = await this.activeVouchesReceivedBy(target.userId)
      .orderBy('v.createdAt', 'DESC')
      .addOrderBy('v.id', 'DESC')
      .offset(page?.offset ?? 0)
      .limit(page?.limit ?? DEFAULT_PAGE_SIZE)
      .getMany();
    // Anonymous vouchers are shielded: never resolve their profile (so an
    // identity can't leak) and emit a redacted view. Non-anonymous rows resolve
    // as usual.
    const voucherProfiles = await this.profilesByUserIds(
      rows.filter((v) => !v.anonymous).map((v) => v.voucherId),
    );
    const vouchers = rows.map((v) =>
      v.anonymous
        ? this.toShieldedVouchView(v.note, v.createdAt, v.relationships)
        : this.toVouchView(
            voucherProfiles.get(v.voucherId),
            v.note,
            v.createdAt,
            v.relationships,
          ),
    );
    return { count, vouchers };
  }

  /**
   * The vouches the CALLER has given. Deliberately NOT block-filtered: this is
   * the voucher's own record of what they did, and it is the only surface from
   * which they can withdraw a vouch. Hiding a severed vouch here would take
   * that away while the row still sat in the table.
   */
  async listGiven(
    voucherId: string,
    page?: PageParams,
  ): Promise<GivenVouchView[]> {
    const rows = await this.vouches.find({
      where: { voucherId, withdrawnAt: IsNull() },
      order: { createdAt: 'DESC' },
      take: page?.limit ?? DEFAULT_PAGE_SIZE,
      skip: page?.offset ?? 0,
    });
    const voucheeProfiles = await this.profilesByUserIds(
      rows.map((v) => v.voucheeId),
    );
    return rows.map((v) =>
      this.toVouchView(
        voucheeProfiles.get(v.voucheeId),
        v.note,
        v.createdAt,
        v.relationships,
      ),
    );
  }

  /**
   * The member's headline "N vouches", block-severed. This is the number
   * `toProfileCard` prints beside the roster `listVouchers` returns, so the two
   * share `activeVouchesReceivedBy` rather than each writing their own filter.
   */
  getVouchCount(userId: string): Promise<number> {
    return this.activeVouchesReceivedBy(userId).getCount();
  }

  async getVouchCounts(userIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (!userIds.length) {
      return map;
    }
    const rows = await this.vouches
      .createQueryBuilder('v')
      .select('v.voucheeId', 'voucheeId')
      .addSelect('COUNT(*)', 'count')
      .where('v.voucheeId IN (:...ids)', { ids: userIds })
      .andWhere('v.withdrawnAt IS NULL')
      // The batched analogue of the `BlockFilterService.excludeBlocked`
      // predicate `activeVouchesReceivedBy` applies. That method binds ONE
      // actor id, and here the actor varies per row (it is the vouchee of the
      // row being counted), so the severance is written pair-correlated
      // instead. Same two directions, same symmetry: a block placed by either
      // side drops the vouch. Kept in step with `getVouchCount` so a member's
      // directory card and their profile page never print two different
      // numbers.
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM "blocks" "__vouch_block"
          WHERE ("__vouch_block"."blocker_id" = "v"."vouchee_id" AND "__vouch_block"."blocked_id" = "v"."voucher_id")
             OR ("__vouch_block"."blocked_id" = "v"."vouchee_id" AND "__vouch_block"."blocker_id" = "v"."voucher_id")
        )`,
      )
      .groupBy('v.voucheeId')
      .getRawMany<{ voucheeId: string; count: string }>();
    for (const row of rows) {
      map.set(row.voucheeId, parseInt(row.count, 10));
    }
    return map;
  }

  /**
   * The user ids the voucher currently has an ACTIVE vouch for (withdrawn rows
   * excluded). The connections "vouched" tab and its badge count intersect this
   * set with the viewer's accepted connections, so the trust-graph read stays in
   * this module rather than querying the `Vouch` repository from connections.
   */
  async getActiveVoucheeIds(voucherId: string): Promise<string[]> {
    const rows = await this.vouches.find({
      where: { voucherId, withdrawnAt: IsNull() },
      select: { voucheeId: true },
    });
    return rows.map((vouch) => vouch.voucheeId);
  }

  /**
   * The user ids who currently hold an ACTIVE, NON-ANONYMOUS vouch for
   * `voucheeId`, newest first and capped at `NAMED_VOUCHER_SCAN_CAP`.
   *
   * Three exclusions carry the whole privacy contract of this read, and they
   * live here rather than in the caller so no later caller can forget them:
   *
   *  - `withdrawnAt IS NULL` — a withdrawn vouch is excluded everywhere else
   *    (see `getVouchCount`), and must be here too.
   *  - block severance, via `activeVouchesReceivedBy`. A vouch from someone
   *    the member has blocked (or who blocked them) does not exist on any
   *    member-facing surface, so it must not feed the "members you know
   *    vouched for them" cue either.
   *  - `anonymous = false` — an anonymous voucher is shielded from the vouchee
   *    in `listVouchers` and from the connections badge in
   *    `getVouchDirections`. Handing their id to a viewer-relative intersection
   *    would de-anonymize them the moment that viewer's connection set is
   *    small, which is exactly the common case.
   *
   * The cap bounds the `IN (...)` list the caller builds from this set. A
   * member with more named vouchers than the cap yields a count over their
   * newest `NAMED_VOUCHER_SCAN_CAP` vouchers, which is a lower bound, never an
   * over-count. The trust cue this backs ("members you know vouched for them")
   * reads the same at 8 as at 80.
   */
  async getNamedVoucherIds(voucheeId: string): Promise<string[]> {
    const rows = await this.activeVouchesReceivedBy(voucheeId)
      .andWhere('v.anonymous = false')
      .select('v.voucherId', 'voucher_id')
      .orderBy('v.createdAt', 'DESC')
      .addOrderBy('v.id', 'DESC')
      .limit(NAMED_VOUCHER_SCAN_CAP)
      .getRawMany<{ voucher_id: string }>();
    return rows.map((row) => row.voucher_id);
  }

  /**
   * Whether ANY of `voucherIds` currently holds an active (non-withdrawn) vouch
   * for `voucheeId`. Powers community second-vouch gating: a community that
   * requires a vouch to join admits an applicant only when a current member has
   * vouched for them platform-wide. Empty `voucherIds` (e.g. a community with no
   * roster) is trivially `false` — nobody can have vouched.
   */
  async hasActiveVouchFrom(
    // Deliberately NOT block-filtered. This is an access decision (it admits an
    // applicant to a community), and filtering it would mean blocking one
    // member could silently cost you entry to a community you already
    // qualified for. Flagged as an open call rather than changed here.
    voucherIds: string[],
    voucheeId: string,
  ): Promise<boolean> {
    if (!voucherIds.length) return false;
    return this.vouches.exists({
      where: {
        voucherId: In(voucherIds),
        voucheeId,
        withdrawnAt: IsNull(),
      },
    });
  }

  /**
   * The active vouches between `viewerUserId` and each of `otherIds`, split by
   * direction. One query loads every vouch in either direction across the set —
   * the same read the connections vouch badge used to run against the `Vouch`
   * repository directly.
   *
   * Not block-filtered, and it does not need to be: the only caller intersects
   * this with the viewer's ACCEPTED connections, and `SocialService.blockMember`
   * flips the pair's connection edge to `Blocked` in the same transaction as
   * the block. A blocked pair therefore has no accepted connection to carry a
   * badge.
   */
  async getVouchDirections(
    viewerUserId: string,
    otherIds: string[],
  ): Promise<VouchDirections> {
    const youVouched = new Set<string>();
    const vouchedForYou = new Set<string>();
    if (!otherIds.length) {
      return { youVouched, vouchedForYou };
    }
    const vouches = await this.vouches.find({
      where: [
        {
          voucherId: viewerUserId,
          voucheeId: In(otherIds),
          withdrawnAt: IsNull(),
        },
        {
          voucheeId: viewerUserId,
          voucherId: In(otherIds),
          withdrawnAt: IsNull(),
        },
      ],
    });
    for (const vouch of vouches) {
      if (vouch.voucherId === viewerUserId) {
        // The viewer's own outgoing vouch — they know they made it, so anonymity
        // (which shields the voucher from the vouchee, not from themselves) does
        // not apply to this direction.
        youVouched.add(vouch.voucheeId);
      }
      if (vouch.voucheeId === viewerUserId && !vouch.anonymous) {
        // An INCOMING vouch surfaces as a "vouched-for-you" badge on that
        // member's card. The viewer knows the member's identity from the
        // connection, so surfacing an anonymous vouch here would de-anonymize
        // the voucher — skip it.
        vouchedForYou.add(vouch.voucherId);
      }
    }
    return { youVouched, vouchedForYou };
  }

  /**
   * The one definition of "an active vouch this member has received": not
   * withdrawn, and not severed by a block in either direction between the
   * member and the voucher.
   *
   * The block filter is **target-relative**, deliberately, and carries no
   * viewer: a block is a hard mutual severance placed between these two
   * people, so the vouch stops existing for the member, for the voucher and
   * for every visitor alike. That matches `SocialService.blockMember`, which
   * flips the pair's connection edge to `Blocked` for everyone rather than
   * hiding it from one side. A viewer-relative filter would have left the
   * blocked voucher's face on the member's own profile, which is the whole
   * complaint.
   *
   * Every member-facing count and roster is built from this, so the number and
   * the list can never disagree. Reads that are NOT built from it, and why, are
   * called out on each of them: `listGiven`/`getActiveVoucheeIds` (a voucher's
   * own outgoing record, which they must still be able to withdraw),
   * `getVouchDirections` and `hasActiveVouchFrom`.
   */
  private activeVouchesReceivedBy(
    voucheeId: string,
  ): SelectQueryBuilder<Vouch> {
    const query = this.vouches
      .createQueryBuilder('v')
      .where('v.voucheeId = :voucheeId', { voucheeId })
      .andWhere('v.withdrawnAt IS NULL');
    // Raw-SQL column reference, snake_case and pre-quoted, matching the `v`
    // alias and the `SnakeNamingStrategy` column name, per `excludeBlocked`'s
    // contract. Called once per builder — it binds a fixed parameter name.
    this.blockFilter.excludeBlocked(query, voucheeId, '"v"."voucher_id"');
    return query;
  }

  private async profilesByUserIds(
    userIds: string[],
  ): Promise<Map<string, Profile>> {
    if (!userIds.length) {
      return new Map();
    }
    const profiles = await this.profiles.find({
      where: { userId: In(userIds) },
    });
    return new Map(profiles.map((p) => [p.userId, p]));
  }

  private toVouchView(
    profile: Profile | undefined,
    note: string | null,
    createdAt: Date,
    relationships: VouchRelationship[] | null = null,
  ): VoucherView {
    return {
      slug: profile?.slug ?? '',
      firstName: profile?.firstName ?? '',
      lastName: profile?.lastName ?? '',
      // Honours the voucher's own `photoVisible` toggle through the shared
      // `toVisibleAvatarUrl` gate, the same one `toMemberRef` applies to every
      // other cross-domain member reference (feed authors, gathering hosts).
      // Without it a member who hid their photo still had their face rendered
      // to every visitor of a profile they vouched for. No owner-self
      // exception, matching that helper: this view carries no viewer identity,
      // and the owner still sees their own photo on their full profile via
      // `gateAvatarUrl`. `toVisibleAvatarUrl` absorbs the undefined-profile
      // case, so it needs no `?.` of its own.
      avatarUrl: toVisibleAvatarUrl(profile),
      note,
      createdAt,
      anonymous: false,
      relationships,
    };
  }

  /**
   * A voucher who vouched anonymously, with every identifying field redacted.
   * The note and timestamp are kept (the voucher authored the note knowing they
   * were anonymous), but the slug/name/avatar are never resolved or emitted, so
   * the client cannot link the vouch back to a member.
   */
  private toShieldedVouchView(
    note: string | null,
    createdAt: Date,
    relationships: VouchRelationship[] | null = null,
  ): VoucherView {
    return {
      slug: '',
      firstName: '',
      lastName: '',
      avatarUrl: null,
      note,
      createdAt,
      anonymous: true,
      relationships,
    };
  }
}
