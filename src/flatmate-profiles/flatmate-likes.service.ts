import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { BlockFilterService } from '../social/block-filter.service';
import {
  FlatmateLike,
  FlatmateLikeDecision,
} from './entities/flatmate-like.entity';
import { FlatmateProfile } from './entities/flatmate-profile.entity';

export interface DecideResult {
  decision: FlatmateLikeDecision;
  /** True only when both members have a `like` pointing at each other's
   * profile — the one signal that unlocks a hello in discovery. */
  matched: boolean;
}

/**
 * Records like/pass decisions from the optional discovery deck and reports
 * mutual matches. Deliberately minimal: no notifications, no exposure, no
 * ranking — a like is private until it is reciprocated.
 */
@Injectable()
export class FlatmateLikesService {
  constructor(
    @InjectRepository(FlatmateLike)
    private readonly likes: Repository<FlatmateLike>,
    @InjectRepository(FlatmateProfile)
    private readonly flatmates: Repository<FlatmateProfile>,
    private readonly blockFilter: BlockFilterService,
    // A profile under a `flatmate` takedown is not decidable from the deck.
    private readonly contentModeration: ContentModerationService,
  ) {}

  /** The subject code a flatmate profile is reported and taken down under,
   *  keyed by the profile slug. Same value `FlatmateDirectoryService` filters
   *  browse and detail on. */
  private static readonly SUBJECT_TYPE = 'flatmate';

  async decide(
    viewerId: string,
    slug: string,
    decision: FlatmateLikeDecision,
  ): Promise<DecideResult> {
    const target = await this.flatmates.findOne({ where: { slug } });
    if (!target) {
      throw new NotFoundException('Flatmate profile not found');
    }
    if (target.ownerId === viewerId) {
      throw new BadRequestException('You cannot like your own profile');
    }
    // Same block severance the browse/detail paths enforce — a block either way
    // hides the profile entirely (404, never a "blocked" signal).
    if (await this.blockFilter.isBlockedEitherWay(viewerId, target.ownerId)) {
      throw new NotFoundException('Flatmate profile not found');
    }
    // A moderator takedown withholds the profile here too. Browse already drops
    // it from the deck in-query, so this closes the direct-by-slug call a client
    // holding a stale deck (or an old link) can still make.
    const moderation = await this.contentModeration.stateFor(
      FlatmateLikesService.SUBJECT_TYPE,
      slug,
    );
    if (moderation.hidden || moderation.removed) {
      throw new NotFoundException('Flatmate profile not found');
    }

    // Idempotent per (viewer, profile): re-deciding overwrites the prior row.
    await this.likes.upsert(
      { fromUserId: viewerId, toProfileId: target.id, decision },
      ['fromUserId', 'toProfileId'],
    );

    if (decision !== FlatmateLikeDecision.Like) {
      return { decision, matched: false };
    }
    return { decision, matched: await this.isMutual(viewerId, target.ownerId) };
  }

  /**
   * Which of `candidates` the viewer is MUTUALLY matched with, as a set of
   * flatmate-profile ids, in two bounded queries however many candidates are
   * passed (ENG-51).
   *
   * This exists because `identity_visibility = 'matches'` now means an actual
   * match rather than "the viewer set their own `type` to the opposite value",
   * and the gate is evaluated for a whole page of browse candidates at once.
   * A per-candidate `isMutual` there would be the N+1 the rest of this module
   * goes out of its way to avoid, on the hot path of the board's main read.
   *
   * Both directions are checked explicitly, unlike `isMutual`, which can assume
   * the viewer's own like was just written by the call it serves. Here nothing
   * has been written, so "mutual" has to mean both rows are present:
   *
   *  - the viewer liked the candidate's profile, and
   *  - the candidate's owner liked the viewer's profile.
   *
   * Two `In(...)` queries intersected in JS rather than one self-join, matching
   * how the media-reference resolver batches the same shape: the sets are small
   * (one page of candidates) and the join would have to be written against
   * aliases on both sides of the same table.
   *
   * A viewer with no profile of their own gets an empty set, for exactly the
   * reason `isMutual` gives: there is nothing for the other side to have liked
   * back, so no match can exist. Note this is also the fail-closed direction,
   * which is what a special-category gate should default to.
   */
  async mutuallyMatchedProfileIds(
    viewerId: string,
    candidates: readonly { id: string; ownerId: string }[],
  ): Promise<Set<string>> {
    if (!candidates.length) return new Set();

    const viewerProfile = await this.flatmates.findOne({
      where: { ownerId: viewerId },
      select: ['id'],
    });
    if (!viewerProfile) return new Set();

    const candidateProfileIds = candidates.map((candidate) => candidate.id);
    const candidateOwnerIds = [
      ...new Set(candidates.map((candidate) => candidate.ownerId)),
    ];

    const [likedByViewer, likedTheViewer] = await Promise.all([
      this.likes.find({
        where: {
          fromUserId: viewerId,
          toProfileId: In(candidateProfileIds),
          decision: FlatmateLikeDecision.Like,
        },
        select: ['toProfileId'],
      }),
      this.likes.find({
        where: {
          fromUserId: In(candidateOwnerIds),
          toProfileId: viewerProfile.id,
          decision: FlatmateLikeDecision.Like,
        },
        select: ['fromUserId'],
      }),
    ]);

    const profileIdsViewerLiked = new Set(
      likedByViewer.map((like) => like.toProfileId),
    );
    const ownerIdsWhoLikedViewer = new Set(
      likedTheViewer.map((like) => like.fromUserId),
    );

    return new Set(
      candidates
        .filter(
          (candidate) =>
            profileIdsViewerLiked.has(candidate.id) &&
            ownerIdsWhoLikedViewer.has(candidate.ownerId),
        )
        .map((candidate) => candidate.id),
    );
  }

  /** A match needs the viewer to own a profile the target could have liked back;
   * without one there is nothing to reciprocate, so it is never mutual. */
  private async isMutual(
    viewerId: string,
    targetOwnerId: string,
  ): Promise<boolean> {
    const myProfile = await this.flatmates.findOne({
      where: { ownerId: viewerId },
    });
    if (!myProfile) return false;
    return this.likes.exists({
      where: {
        fromUserId: targetOwnerId,
        toProfileId: myProfile.id,
        decision: FlatmateLikeDecision.Like,
      },
    });
  }
}
