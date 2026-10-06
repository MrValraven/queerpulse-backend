import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { IdentityBlock } from '../identities/entities/identity-block.entity';
import { Block } from './entities/block.entity';
import { Mute } from './entities/mute.entity';

/** ENG-447: a block of an identity itself, or one carried to it from a
 *  persona that went unlinked (see `BlockFilterService.identityBlockKind`). */
export type IdentityBlockKind = 'direct' | 'carried';

/**
 * Cross-cutting block/mute enforcement (spec §2). Exported from
 * `SocialModule` for other domains (messaging, connections, profiles/members
 * directory, feed) to wire in — see the module report for the exact import
 * path. Enforcement here is server-authoritative; callers must not rely on
 * the frontend to have already filtered anything.
 */
@Injectable()
export class BlockFilterService {
  constructor(
    @InjectRepository(Block) private readonly blocks: Repository<Block>,
    @InjectRepository(Mute) private readonly mutes: Repository<Mute>,
    @InjectRepository(IdentityBlock)
    private readonly identityBlocks: Repository<IdentityBlock>,
  ) {}

  /**
   * Hard severance, direction-agnostic: `true` if either `aUserId` blocked
   * `bUserId` or `bUserId` blocked `aUserId`. Use this to gate messaging,
   * connection requests, and any other mutual interaction — a block from
   * either side should sever it.
   */
  async isBlockedEitherWay(aUserId: string, bUserId: string): Promise<boolean> {
    if (aUserId === bUserId) return false;
    return this.blocks.exist({
      where: [
        { blockerId: aUserId, blockedId: bUserId },
        { blockerId: bUserId, blockedId: aUserId },
      ],
    });
  }

  /**
   * One-way, soft silence: `true` when `actorId` has muted `targetId` — i.e.
   * `targetId` should be suppressed (hidden from feeds/lists, notifications
   * skipped) from `actorId`'s point of view. Unlike `isBlockedEitherWay`,
   * this is directional and never implies the reverse.
   */
  async isMutedBy(actorId: string, targetId: string): Promise<boolean> {
    if (actorId === targetId) return false;
    return this.mutes.exist({
      where: { muterId: actorId, mutedId: targetId },
    });
  }

  /**
   * Appends a `NOT EXISTS` predicate to `qb` that drops rows whose member
   * column is blocked either way relative to `actorId`. `memberIdColumn`
   * is spliced verbatim into raw SQL, so pass an actual, already-quoted
   * `"alias"."snake_case_column"` reference matching `qb`'s alias and the
   * DB's `SnakeNamingStrategy` column name (e.g. `'"cp"."author_id"'`), not
   * a TypeORM camelCase property path. Call once per query builder — the
   * bound parameter name (`blockFilterActorId`) is fixed.
   *
   * `options.unless`, when given, is a raw SQL boolean expression (same
   * verbatim-splice contract as `memberIdColumn`, never caller-controlled
   * input) OR'd in front of the `NOT EXISTS`, so a row that satisfies it is
   * kept regardless of a block. Two callers: a group's own system pills,
   * which must stay visible to every member even when their actor is blocked
   * (`"m"."kind" = 'system'`), and a query spanning several conversation
   * kinds where the block gate should only bite for one of them (a search
   * across DMs and groups scoping the filter to group rows). Omit it for
   * the plain, unconditional filter every existing caller already gets.
   */
  excludeBlocked<E extends ObjectLiteral>(
    qb: SelectQueryBuilder<E>,
    actorId: string,
    memberIdColumn: string,
    options?: { unless: string },
  ): SelectQueryBuilder<E> {
    const notBlocked = `NOT EXISTS (
        SELECT 1 FROM "blocks" "__block_filter"
        WHERE ("__block_filter"."blocker_id" = :blockFilterActorId AND "__block_filter"."blocked_id" = ${memberIdColumn})
           OR ("__block_filter"."blocked_id" = :blockFilterActorId AND "__block_filter"."blocker_id" = ${memberIdColumn})
      )`;
    const predicate = options
      ? `(${options.unless} OR ${notBlocked})`
      : notBlocked;
    return qb.andWhere(predicate, { blockFilterActorId: actorId });
  }

  /**
   * Directional sibling of `excludeBlocked`: appends a `NOT EXISTS` predicate
   * dropping rows whose member column `actorId` has muted. Same raw-SQL
   * splicing contract as `excludeBlocked` — pass an already-quoted
   * `"alias"."snake_case_column"`. Binds its own parameter name
   * (`muteFilterActorId`), so a single query builder can safely carry both
   * this and `excludeBlocked`; like that method, call it at most once per
   * query builder.
   *
   * Content lists generally want BOTH (a block hides bidirectionally, a mute
   * one-directionally) — see `excludeHidden`, which applies the pair.
   */
  excludeMuted<E extends ObjectLiteral>(
    qb: SelectQueryBuilder<E>,
    actorId: string,
    memberIdColumn: string,
  ): SelectQueryBuilder<E> {
    return qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "mutes" "__mute_filter"
        WHERE "__mute_filter"."muter_id" = :muteFilterActorId
          AND "__mute_filter"."muted_id" = ${memberIdColumn}
      )`,
      { muteFilterActorId: actorId },
    );
  }

  /**
   * The composition every *content list* should use: hide authors blocked in
   * either direction (hard severance) and authors `actorId` has muted (soft,
   * one-way silence — `isMutedBy`'s docstring: a muted author's content is
   * "hidden from feeds/lists"). This is the in-query equivalent of
   * `FeedService.dropBlocked`, and is preferred over it: filtering inside the
   * query lets `LIMIT` count only visible rows, so a page of 20 comes back
   * with 20 items instead of being silently short (the known flaw of
   * post-query filtering).
   */
  excludeHidden<E extends ObjectLiteral>(
    qb: SelectQueryBuilder<E>,
    actorId: string,
    memberIdColumn: string,
  ): SelectQueryBuilder<E> {
    this.excludeBlocked(qb, actorId, memberIdColumn);
    return this.excludeMuted(qb, actorId, memberIdColumn);
  }

  /**
   * Batched set lookup for collections that are **not** paginated in SQL —
   * nested replies, attendee lists — where the in-query `excludeHidden`
   * predicate has nowhere to attach and post-query filtering carries no
   * short-page penalty (there is no `LIMIT` to under-fill).
   *
   * Two queries total regardless of `candidateIds` length, unlike
   * `FeedService.dropBlocked`'s per-author `exist()` calls. `actorId` is never
   * reported as hidden from itself.
   */
  async blockedUserIds(
    actorId: string,
    candidateIds: string[],
  ): Promise<Set<string>> {
    const ids = [...new Set(candidateIds)].filter((id) => id !== actorId);
    if (!ids.length) return new Set();
    const rows = await this.blocks.find({
      where: [
        { blockerId: actorId, blockedId: In(ids) },
        { blockedId: actorId, blockerId: In(ids) },
      ],
      select: { blockerId: true, blockedId: true },
    });
    return new Set(
      rows.map((r) => (r.blockerId === actorId ? r.blockedId : r.blockerId)),
    );
  }

  /** One-way companion to `blockedUserIds`: the subset `actorId` has muted. */
  async mutedUserIds(
    actorId: string,
    candidateIds: string[],
  ): Promise<Set<string>> {
    const ids = [...new Set(candidateIds)].filter((id) => id !== actorId);
    if (!ids.length) return new Set();
    const rows = await this.mutes.find({
      where: { muterId: actorId, mutedId: In(ids) },
      select: { mutedId: true },
    });
    return new Set(rows.map((r) => r.mutedId));
  }

  /**
   * Directional mirror of `mutedUserIds`: the subset of `candidateIds` who
   * have muted `targetId` — i.e. members from whose point of view `targetId`
   * is silenced. Where `mutedUserIds(actor, …)` answers "whom did the actor
   * mute?", this answers "who muted this member?". Used to suppress a push to a
   * recipient who muted the sender (a person-level mute, distinct from muting a
   * single conversation). `targetId` is never reported as muting itself.
   */
  async mutersOf(
    targetId: string,
    candidateIds: string[],
  ): Promise<Set<string>> {
    const ids = [...new Set(candidateIds)].filter((id) => id !== targetId);
    if (!ids.length) return new Set();
    const rows = await this.mutes.find({
      where: { muterId: In(ids), mutedId: targetId },
      select: { muterId: true },
    });
    return new Set(rows.map((r) => r.muterId));
  }

  /**
   * Multi-actor block gate (PRD-354): the subset of `candidateIds` blocked
   * EITHER WAY with ANY of `guardianIds` (e.g. every active member of a
   * group, so adding/inviting someone blocked by even one existing member is
   * refused, not just a block with the adder) OR with another member of the
   * SAME candidate batch (two people seated by the same `createGroup`/
   * `addMembers` call who blocked each other must both be refused, not
   * silently seated together). Folding `candidateIds` into the guarded set
   * for this query catches both shapes in ONE round trip: a block row counts
   * if one side names a candidate and the other names a guardian OR another
   * candidate, in either blocker/blocked position. A block row can never
   * pair a user with themselves, so no self-pair exclusion is needed.
   * `actorId`-only gates (a DM, a single-adder check) should keep using
   * `blockedUserIds` instead: this is for the "any of several" case.
   */
  async blockedAgainstAnyOf(
    candidateIds: string[],
    guardianIds: string[],
  ): Promise<Set<string>> {
    const candidates = new Set(candidateIds);
    const guarded = [...new Set([...guardianIds, ...candidateIds])];
    if (!candidates.size || !guarded.length) return new Set();
    const rows = await this.blocks.find({
      where: [
        { blockerId: In([...candidates]), blockedId: In(guarded) },
        { blockedId: In([...candidates]), blockerId: In(guarded) },
      ],
      select: { blockerId: true, blockedId: true },
    });
    const blocked = new Set<string>();
    for (const row of rows) {
      if (candidates.has(row.blockerId)) blocked.add(row.blockerId);
      if (candidates.has(row.blockedId)) blocked.add(row.blockedId);
    }
    return blocked;
  }

  /**
   * Task 14: whether `blockerUserId` blocked the business, persona or
   * company `identityId` (`identity_blocks`). Directional: a business never
   * blocks a member. A block of the identity's owner as a person lives in
   * `blocks` and never answers here, and a block of the identity leaves its
   * owner's own profile identity unblocked, since the two are separate
   * relationships (see `IdentityBlock`). A block the member placed on a
   * persona before it went unlinked counts against the persona's current
   * identity (ENG-447, `carriedIdentityBlocksAmong`).
   */
  async isIdentityBlocked(
    blockerUserId: string,
    identityId: string,
  ): Promise<boolean> {
    const isDirectlyBlocked = await this.identityBlocks.exist({
      where: { blockerUserId, identityId },
    });
    if (isDirectlyBlocked) return true;
    const carried = await this.carriedIdentityBlocksAmong(
      [blockerUserId],
      [identityId],
    );
    return carried.length > 0;
  }

  /**
   * ENG-447: which block, if any, `blockerUserId` holds against
   * `identityId`: `direct` for a block of that identity, `carried` for one
   * placed on a persona before it went unlinked that now holds against the
   * identity the persona speaks through. Both refuse the same. A refusal
   * that only a carried block causes must read to the blocker as a persona
   * nobody answers for (`MessageRequestsService.identityEnquiryBlockedReason`):
   * read as a block, it would tell anyone who blocked a named persona which
   * pseudonym it became. A direct block wins when both hold.
   */
  async identityBlockKind(
    blockerUserId: string,
    identityId: string,
  ): Promise<IdentityBlockKind | null> {
    const isDirectlyBlocked = await this.identityBlocks.exist({
      where: { blockerUserId, identityId },
    });
    if (isDirectlyBlocked) return 'direct';
    const carried = await this.carriedIdentityBlocksAmong(
      [blockerUserId],
      [identityId],
    );
    return carried.length > 0 ? 'carried' : null;
  }

  /** Task 14: every identity `blockerUserId` has blocked, in one query,
   *  plus the current identity of each persona a carried block names. */
  async blockedIdentityIds(blockerUserId: string): Promise<string[]> {
    const [rows, carried] = await Promise.all([
      this.identityBlocks.find({
        where: { blockerUserId },
        select: { identityId: true },
      }),
      this.carriedIdentityBlocksAmong([blockerUserId]),
    ]);
    return [
      ...new Set([
        ...rows.flatMap((row) => (row.identityId ? [row.identityId] : [])),
        ...carried.map((row) => row.identityId),
      ]),
    ];
  }

  /**
   * Task 14: the `identity_blocks` rows whose blocker is one of
   * `blockerUserIds` and whose identity is one of `identityIds`, in one
   * query however many threads asked. A caller that needs exact pairs keeps
   * the rows it asked for (`loadMailboxIdentityBlockKeys` in
   * `mailbox-seats.ts` does), since the cross product can return more.
   * Carried blocks (ENG-447) answer as pairs with the persona's current
   * identity.
   */
  async identityBlocksAmong(
    blockerUserIds: string[],
    identityIds: string[],
  ): Promise<Array<{ blockerUserId: string; identityId: string }>> {
    const uniqueBlockerUserIds = [...new Set(blockerUserIds)];
    const uniqueIdentityIds = [...new Set(identityIds)];
    if (!uniqueBlockerUserIds.length || !uniqueIdentityIds.length) return [];
    const [rows, carried] = await Promise.all([
      this.identityBlocks.find({
        where: {
          blockerUserId: In(uniqueBlockerUserIds),
          identityId: In(uniqueIdentityIds),
        },
        select: { blockerUserId: true, identityId: true },
      }),
      this.carriedIdentityBlocksAmong(uniqueBlockerUserIds, uniqueIdentityIds),
    ]);
    return [
      ...rows.flatMap((row) =>
        row.identityId
          ? [{ blockerUserId: row.blockerUserId, identityId: row.identityId }]
          : [],
      ),
      ...carried,
    ];
  }

  /**
   * ENG-447: the blocks carried across a persona going unlinked, as the
   * pairs they enforce today. A carried row names the persona
   * (`blocked_subprofile_id`), since the identity the member blocked was
   * retired with the unlink, and it refuses the identity the persona speaks
   * through now, exactly as a direct block of that identity would. With no
   * `identityIds`, every current identity a carried block of the blockers
   * reaches. A persona with no identity yet yields no pair: there is no
   * mailbox to refuse until one is minted, and the pair appears the moment
   * it is.
   */
  private async carriedIdentityBlocksAmong(
    blockerUserIds: string[],
    identityIds?: string[],
  ): Promise<Array<{ blockerUserId: string; identityId: string }>> {
    const rows: Array<{ blockerUserId: string; identityId: string }> =
      await this.identityBlocks.query(
        `SELECT "carried_block"."blocker_user_id" AS "blockerUserId",
                "carried_identity"."id" AS "identityId"
           FROM "identity_blocks" "carried_block"
          INNER JOIN "identities" "carried_identity"
             ON "carried_identity"."subprofile_id" = "carried_block"."blocked_subprofile_id"
          WHERE "carried_block"."blocked_subprofile_id" IS NOT NULL
            AND "carried_block"."blocker_user_id" = ANY($1::uuid[])
            AND ($2::uuid[] IS NULL OR "carried_identity"."id" = ANY($2::uuid[]))`,
        [blockerUserIds, identityIds ?? null],
      );
    return rows.map((row) => ({
      blockerUserId: row.blockerUserId,
      identityId: row.identityId,
    }));
  }

  /** Union of `blockedUserIds` and `mutedUserIds` — the post-query analogue
   *  of `excludeHidden`, for non-paginated collections. */
  async hiddenUserIds(
    actorId: string,
    candidateIds: string[],
  ): Promise<Set<string>> {
    const [blocked, muted] = await Promise.all([
      this.blockedUserIds(actorId, candidateIds),
      this.mutedUserIds(actorId, candidateIds),
    ]);
    for (const id of muted) blocked.add(id);
    return blocked;
  }
}
