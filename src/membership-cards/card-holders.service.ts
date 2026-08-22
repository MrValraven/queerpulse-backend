import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { Profile } from '../users/entities/profile.entity';
import { toImageUrl } from '../common/image-url';
import { effectiveCardStatus } from './card-status';
import { CardProgramsService } from './card-programs.service';
import { IssuerCardDTO, toIssuerCard } from './membership-card-response';
import {
  MembershipCardsService,
  type RosterIssueResult,
} from './membership-cards.service';

/** The issuer's view of who holds a card. Owner and mod only. */
@Injectable()
export class CardHoldersService {
  constructor(
    private readonly membership: CommunityMembershipService,
    private readonly programs: CardProgramsService,
    private readonly cards: MembershipCardsService,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  async issueForCommunity(
    slug: string,
    actorId: string,
  ): Promise<RosterIssueResult> {
    const communityId = await this.membership.assertOwnerOrModBySlug(
      slug,
      actorId,
    );
    const program = await this.programs.programForCommunity(communityId);
    if (!program) throw new NotFoundException('Card programme not found');
    return this.cards.issueForRoster(program.id);
  }

  async listForCommunity(
    slug: string,
    actorId: string,
  ): Promise<IssuerCardDTO[]> {
    const communityId = await this.membership.assertOwnerOrModBySlug(
      slug,
      actorId,
    );
    const program = await this.programs.programForCommunity(communityId);
    if (!program) return [];

    const community = await this.communities.findOne({
      where: { id: communityId },
    });
    if (!community) return [];

    const cards = await this.cards.cardsForProgram(program.id);
    if (cards.length === 0) return [];

    // Display name / slug / avatar live on `Profile` (`firstName`/`lastName`/
    // `slug`/`avatarUrl`), not `User`. Batched: one query for every holder
    // rather than one per card.
    const holderProfiles = await this.profiles.find({
      where: { userId: In(cards.map((card) => card.userId)) },
    });
    const profileByUserId = new Map(
      holderProfiles.map((profile) => [profile.userId, profile]),
    );

    return cards.map((card) => {
      const profile = profileByUserId.get(card.userId);
      return toIssuerCard(
        card,
        effectiveCardStatus({
          status: card.status,
          expiresAt: card.expiresAt,
          programEnabled: program.isEnabled,
          communityFrozenAt: community.frozenAt,
          communityArchivedAt: community.archivedAt,
        }),
        {
          holderSlug: profile?.slug ?? '',
          holderName: profile
            ? [profile.firstName, profile.lastName].filter(Boolean).join(' ')
            : 'A member',
          avatarUrl: profile?.avatarUrl ? toImageUrl(profile.avatarUrl) : null,
        },
      );
    });
  }
}
