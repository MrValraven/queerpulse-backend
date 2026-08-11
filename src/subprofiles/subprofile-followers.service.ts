import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { toImageUrl } from '../common/image-url';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { SubprofileFollower } from './entities/subprofile-follower.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
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
    const safeLimit = Math.min(Math.max(limit ?? FOLLOWERS_LIST_CAP, 1), FOLLOWERS_LIST_CAP);
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
        avatarUrl: toImageUrl(profile?.avatarUrl),
      };
    });
    return { count, followers };
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
  // Open visibility, and not block-either-way between `userId` (the
  // follower/viewer) and the persona's owner. Mirrors the gate `getByHandle`
  // applies.
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
      },
    });
    if (!persona) {
      throw new NotFoundException('Subprofile not found');
    }
    if (await this.blockFilter.isBlockedEitherWay(userId, persona.userId)) {
      throw new NotFoundException('Subprofile not found');
    }
    return persona;
  }
}
