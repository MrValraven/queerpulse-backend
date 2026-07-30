import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { BlockFilterService } from '../social/block-filter.service';
import { SubprofileFollower } from './entities/subprofile-follower.entity';
import {
  Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import {
  SUBPROFILE_FOLLOWED,
  SubprofileFollowedEvent,
} from './subprofile.events';

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

  // Batches the follower COUNT for many personas into ONE query (mirrors
  // `loadEndorsementCountsFor`) — there is no `withdrawnAt`: every row in
  // `subprofile_followers` is active, so this counts rows directly.
  async loadFollowerCountsFor(ids: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!ids.length) return counts;
    const rows = await this.followers.find({
      where: { subprofileId: In(ids) },
      select: { subprofileId: true },
    });
    for (const row of rows)
      counts.set(row.subprofileId, (counts.get(row.subprofileId) ?? 0) + 1);
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
