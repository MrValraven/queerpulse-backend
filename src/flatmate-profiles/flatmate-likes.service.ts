import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  ) {}

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
