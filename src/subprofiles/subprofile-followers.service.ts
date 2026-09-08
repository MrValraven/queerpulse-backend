import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { isUniqueViolation } from '../common/db-errors';
import { toImageUrl } from '../common/image-url';
import { toVisibleAvatarUrl } from '../common/member-ref';
import { PAGE_SIZE, Paginated, normalizePage } from '../common/pagination';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import {
  SUBPROFILE_MODERATION_SUBJECT_TYPE,
  isSubprofileUnderTakedown,
} from './subprofile-takedown';
import { SubprofileFollower } from './entities/subprofile-follower.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import { FollowedPersonaView } from './subprofile-following-response';
import { FollowerView } from './subprofile-response';
import {
  SUBPROFILE_FOLLOWED,
  SubprofileFollowedEvent,
} from './subprofile.events';

// Follower pages are capped at 50 rows, newest-first — mirrors
// `ENDORSERS_LIST_CAP`. The owner-facing list is now pageable (optional
// `page`/`limit`), but a single page never exceeds this cap.
const FOLLOWERS_LIST_CAP = 50;

// Owns the follow / unfollow behaviour plus the batched count/viewer-state
// derivations the persona read paths consume. Extracted from
// `SubprofilesService` (which now delegates to it) so the follower concern is
// self-contained; it injects the shared deps it needs directly rather than
// reaching back through the facade (no circular DI).
@Injectable()
export class SubprofileFollowersService {
  constructor(
    @InjectRepository(SubprofileFollower)
    private readonly followers: Repository<SubprofileFollower>,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(SubprofileMember)
    private readonly members: Repository<SubprofileMember>,
    private readonly blockFilter: BlockFilterService,
    private readonly eventEmitter: EventEmitter2,
    // Read-only: `resolveFollowablePersona` withholds a persona under a
    // moderator takedown, the same state every public READ path already
    // applies. `ContentModerationModule` is already imported by
    // `SubprofilesModule` for `SubprofilePublicReadService`.
    private readonly contentModeration: ContentModerationService,
  ) {}

  async follow(
    followerId: string,
    id: string,
  ): Promise<{ followerCount: number; viewerFollowing: boolean }> {
    const persona = await this.resolveFollowablePersona(followerId, id);
    if (persona.userId === followerId) {
      throw new BadRequestException('You cannot follow your own persona');
    }

    // Following is a one-way, instant toggle with no note/soft-withdraw (see
    // the entity): a genuine insert emits the notification event once;
    // re-tapping an already-followed persona (or losing a race to a
    // concurrent follow for the same pair) is idempotent success, no event.
    let justFollowed = false;
    try {
      await this.followers.insert({
        subprofileId: id,
        followerId,
      });
      justFollowed = true;
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      // Already following — idempotent success.
    }

    const followerCount = (await this.loadFollowerCountsFor([id])).get(id) ?? 0;

    if (justFollowed) {
      this.eventEmitter.emit(SUBPROFILE_FOLLOWED, {
        subprofileId: id,
        followerId,
        ownerId: persona.userId,
      } satisfies SubprofileFollowedEvent);
    }

    return { followerCount, viewerFollowing: true };
  }

  async unfollow(
    followerId: string,
    id: string,
  ): Promise<{ followerCount: number; viewerFollowing: boolean }> {
    // No-op if there is no follow row to remove — mirrors
    // `withdrawEndorsement`: the follow control is a toggle, so unfollowing a
    // persona the viewer never followed just settles into "not following".
    await this.followers.delete({ subprofileId: id, followerId });
    const followerCount = (await this.loadFollowerCountsFor([id])).get(id) ?? 0;
    return { followerCount, viewerFollowing: false };
  }

  // Owner-only: lists WHO follows a persona. Following is anonymous to the
  // public (count only), so this is gated to co-owners — the viewer must hold a
  // `subprofile_members` row for this persona (mirrors `SubprofilesService`'s
  // private `isMember`); every non-owner gets a 403 and NEVER an identity. The
  // repo is injected directly rather than delegating back to
  // `SubprofilesService` to avoid a circular DI. Otherwise mirrors
  // `listEndorsers`: in-query block filtering so `LIMIT` and `count` reflect
  // only the viewer's visible rows, newest-first, capped.
  async listFollowers(
    viewerId: string,
    id: string,
    page?: number,
    limit?: number,
  ): Promise<{ count: number; followers: FollowerView[] }> {
    const membership = await this.members.findOne({
      where: { subprofileId: id, userId: viewerId },
      select: { id: true },
    });
    if (!membership) {
      throw new ForbiddenException('Not your subprofile');
    }

    // `count` stays the viewer's full visible total; the returned list is the
    // requested page. Both `page` and `limit` are clamped so a hostile/omitted
    // value can never exceed `FOLLOWERS_LIST_CAP` per page.
    const safeLimit = Math.min(
      Math.max(limit ?? FOLLOWERS_LIST_CAP, 1),
      FOLLOWERS_LIST_CAP,
    );
    const safePage = Math.max(page ?? 1, 1);

    const qb = this.followers
      .createQueryBuilder('sf')
      .where('sf.subprofileId = :id', { id });
    this.blockFilter.excludeBlocked(qb, viewerId, '"sf"."follower_id"');
    qb.orderBy('sf.createdAt', 'DESC');

    const count = await qb.getCount();
    const rows = await qb
      .skip((safePage - 1) * safeLimit)
      .take(safeLimit)
      .getMany();

    const followerProfiles = await this.profiles.find({
      where: { userId: In(rows.map((row) => row.followerId)) },
    });
    const profileByUserId = new Map(
      followerProfiles.map((profile) => [profile.userId, profile]),
    );
    const followers = rows.map((row) => {
      const profile = profileByUserId.get(row.followerId);
      return {
        slug: profile?.slug ?? '',
        name: `${profile?.firstName ?? ''} ${profile?.lastName ?? ''}`.trim(),
        // Honours the follower's own `photoVisible` toggle through the shared
        // gate `toMemberRef` uses, so this list agrees with feed and forum:
        // photo on -> the resolved url, photo off (or no profile row at all)
        // -> null. `FollowerView` is a narrower shape than `MemberRef`
        // (slug/name/avatar only), so it calls the gate directly rather than
        // building a whole ref. There is deliberately no owner-self exception:
        // this list is owner-only, and a member who hid their face stays
        // hidden on it.
        avatarUrl: toVisibleAvatarUrl(profile),
      };
    });
    return { count, followers };
  }

  /**
   * The other side of the follow: every persona THIS member follows, newest
   * follow first, paginated.
   *
   * Following used to be write-only. A member tapped Follow, the owner got one
   * notification, and the follower got a pill and nothing else: no list, no way
   * back to a persona they had followed weeks earlier. This is the read that
   * makes the button mean something (PRD-208).
   *
   * REPEATS THE PUBLIC-READ GATE, IN QUERY. A followed persona can be
   * unpublished, made private, owner-removed, taken down by a moderator, or
   * belong to somebody the viewer has since blocked, and a follow row survives
   * all five. Every one of those states is filtered in SQL rather than after
   * the fetch, so `total` and the page boundary count only rows the viewer may
   * actually see; filtering post-fetch would report a total that includes
   * withheld personas and hand back short pages. The predicates are the same
   * five `resolveFollowablePersona` applies to the WRITE path, so a persona you
   * can no longer follow is a persona you can no longer see here either.
   *
   * The takedown predicate is spelled here rather than borrowed from
   * `SubprofilePublicReadService`, whose two variants are private to that
   * service; it reads the same `content_moderation` rows through the same
   * canonical subject type (`SUBPROFILE_MODERATION_SUBJECT_TYPE`), so there is
   * one spelling of WHICH rows count even though there are two of the SQL.
   *
   * TWO STEPS, DELIBERATELY. The page is chosen by a projection over
   * `subprofile_followers` (`offset`/`limit`, never `skip`/`take`: this query
   * carries a join, and `skip`/`take` wraps a join in a DISTINCT subquery that
   * pages wrongly), then the personas are loaded by id and put back into follow
   * order. `ORDER BY created_at DESC` also takes an `id` tiebreak, or two
   * follows saved in the same millisecond would let an offset boundary repeat
   * one row and skip another.
   */
  async listFollowedPersonas(
    viewerId: string,
    page?: number,
  ): Promise<Paginated<FollowedPersonaView>> {
    const safePage = normalizePage(page);
    const pageQuery = this.followers
      .createQueryBuilder('sf')
      .innerJoin(Subprofile, 'sp', 'sp.id = sf.subprofileId')
      .where('sf.followerId = :viewerId', { viewerId })
      .andWhere('sp.status = :publishedStatus', {
        publishedStatus: SubprofileStatus.Published,
      })
      .andWhere('sp.visibility = :openVisibility', {
        openVisibility: SubprofileVisibility.Open,
      })
      .andWhere('sp.removedAt IS NULL')
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM "content_moderation" "cm"
          WHERE "cm"."subject_type" = :subprofileSubjectType
            AND "cm"."subject_id" = sp.slug
            AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
        )`,
        { subprofileSubjectType: SUBPROFILE_MODERATION_SUBJECT_TYPE },
      );
    this.blockFilter.excludeBlocked(pageQuery, viewerId, '"sp"."user_id"');

    const total = await pageQuery.getCount();
    if (total === 0) {
      return { items: [], total: 0, page: safePage, pageSize: PAGE_SIZE };
    }

    const pageRows = await pageQuery
      .select('sf.subprofileId', 'subprofileId')
      .addSelect('sf.createdAt', 'followedAt')
      .orderBy('sf.createdAt', 'DESC')
      .addOrderBy('sf.id', 'DESC')
      .offset((safePage - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .getRawMany<{ subprofileId: string; followedAt: Date }>();

    const personaIds = pageRows.map((row) => row.subprofileId);
    if (!personaIds.length) {
      return { items: [], total, page: safePage, pageSize: PAGE_SIZE };
    }

    const [personas, followerCounts] = await Promise.all([
      this.subprofiles.find({ where: { id: In(personaIds) } }),
      this.loadFollowerCountsFor(personaIds),
    ]);
    const personaById = new Map(
      personas.map((persona) => [persona.id, persona]),
    );

    // Only a LINKED persona's address needs its creator's profile slug, and
    // only a linked persona may disclose one, so the lookup is narrowed to
    // those owners before it runs: an unlinked persona's owner is never
    // resolved here at all, which is the cheapest way to keep a pseudonymous
    // persona pseudonymous.
    const linkedOwnerIds = personas
      .filter(
        (persona) => persona.linkVisibility === SubprofileLinkVisibility.Linked,
      )
      .map((persona) => persona.userId);
    const ownerProfiles = linkedOwnerIds.length
      ? await this.profiles.find({ where: { userId: In(linkedOwnerIds) } })
      : [];
    const ownerSlugByUserId = new Map(
      ownerProfiles.map((profile) => [profile.userId, profile.slug]),
    );
    // The name parts ride along on the read that already resolves `ownerSlug`,
    // for the row's "Owner Name | Dancer" title on a persona still named after
    // its profession — composed exactly as the directory card's does. An owner
    // with both parts blank composes to "", normalised to null so the persona
    // keeps its bare name rather than titling as " | Dancer".
    const ownerNameByUserId = new Map(
      ownerProfiles.map((profile) => [
        profile.userId,
        `${profile.firstName} ${profile.lastName}`.trim() || null,
      ]),
    );

    const items = pageRows.flatMap<FollowedPersonaView>((row) => {
      const persona = personaById.get(row.subprofileId);
      if (!persona) return [];
      const isLinked =
        persona.linkVisibility === SubprofileLinkVisibility.Linked;
      return [
        {
          id: persona.id,
          displayName: persona.displayName,
          kind: persona.kind,
          tagline: persona.tagline,
          // Through `toImageUrl`, like every other persona mapper: the column
          // holds a storage KEY for an uploaded avatar, and shipping it raw
          // renders as a broken relative image — the row fell back to initials
          // while the directory card, which resolves the key, showed the face.
          avatarUrl: toImageUrl(persona.avatarUrl),
          accent: persona.accent,
          slug: persona.slug,
          // An unlinked persona is addressed by its handle; a linked one is
          // addressed under its creator and its handle is not part of that
          // address, so it is not shipped.
          handle: isLinked ? null : persona.handle,
          linkVisibility: persona.linkVisibility,
          ownerSlug: isLinked
            ? (ownerSlugByUserId.get(persona.userId) ?? null)
            : null,
          ownerName: isLinked
            ? (ownerNameByUserId.get(persona.userId) ?? null)
            : null,
          followerCount: followerCounts.get(persona.id) ?? 0,
          followedAt: row.followedAt,
        },
      ];
    });

    return { items, total, page: safePage, pageSize: PAGE_SIZE };
  }

  // Batches the follower COUNT for many personas into ONE query (mirrors
  // `loadEndorsementCountsFor`) — there is no `withdrawnAt`: every row in
  // `subprofile_followers` is active, so this counts rows directly.
  async loadFollowerCountsFor(ids: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!ids.length) return counts;
    // Grouped SQL COUNT — one row per persona out of Postgres, rather than
    // pulling every follower row into the app to tally. There is no
    // `withdrawnAt`: every `subprofile_followers` row is active.
    const rows = await this.followers
      .createQueryBuilder('follower')
      .select('follower.subprofileId', 'subprofileId')
      .addSelect('COUNT(*)', 'count')
      .where('follower.subprofileId IN (:...ids)', { ids })
      .groupBy('follower.subprofileId')
      .getRawMany<{ subprofileId: string; count: string }>();
    for (const row of rows) counts.set(row.subprofileId, Number(row.count));
    return counts;
  }

  // Batches "is this viewer following this persona" for many personas into
  // ONE query — the `viewerFollowing` companion to `loadFollowerCountsFor`.
  async viewerFollowingFor(
    viewerId: string,
    ids: string[],
  ): Promise<Set<string>> {
    const set = new Set<string>();
    if (!ids.length) return set;
    const rows = await this.followers.find({
      where: { subprofileId: In(ids), followerId: viewerId },
      select: { subprofileId: true },
    });
    for (const row of rows) set.add(row.subprofileId);
    return set;
  }

  // Fetches a persona by id AND enforces it is publicly followable: published,
  // Open visibility, not owner-removed, not under a moderator takedown, and not
  // block-either-way between `userId` (the follower/viewer) and the persona's
  // owner. Mirrors the gate `getByHandle` applies.
  private async resolveFollowablePersona(
    userId: string,
    id: string,
  ): Promise<Subprofile> {
    const persona = await this.subprofiles.findOne({
      // Open + published only: `network`/`private` personas are not publicly
      // endorsable/followable and 404 like any other unreachable persona,
      // matching the gate `getByHandle` / `directory` apply.
      where: {
        id,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
        // A removed persona is unreachable here too, exactly as it is in
        // `directory()` and `listForProfile`. Without this, anyone who loaded
        // the page before the removal kept the uuid and could go on following
        // it, firing a notification at the owner each time.
        removedAt: IsNull(),
      },
    });
    if (!persona) {
      throw new NotFoundException('Subprofile not found');
    }
    // A moderator takedown withholds the persona from every public read path
    // (`dropModeratedSubprofiles` / `excludeModeratedSubprofiles`), so it has
    // to close the write path too. Same predicate, one shared spelling.
    if (await isSubprofileUnderTakedown(this.contentModeration, persona.slug)) {
      throw new NotFoundException('Subprofile not found');
    }
    if (await this.blockFilter.isBlockedEitherWay(userId, persona.userId)) {
      throw new NotFoundException('Subprofile not found');
    }
    return persona;
  }
}
