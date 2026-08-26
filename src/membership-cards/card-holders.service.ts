import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { Profile } from '../users/entities/profile.entity';
import { toImageUrl } from '../common/image-url';
import { CardScanLogService } from './card-scan-log.service';
import { effectiveCardStatus } from './card-status';
import { CardProgramsService } from './card-programs.service';
import { CardTokenService } from './card-token.service';
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
    private readonly tokens: CardTokenService,
    private readonly scanLog: CardScanLogService,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  /**
   * Never throws on an unconfigured platform. A missing signing key should cost
   * the roster its codes, never the whole holders panel.
   */
  private tokenFor(card: { id: string; codeVersion: number }): string | null {
    if (!this.tokens.isConfigured) return null;
    return this.tokens.mint(card.id, card.codeVersion);
  }

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

    // The role the card prints. Batched with the same `In` shape as the
    // profiles above, so a roster of two hundred holders still costs one
    // query. A holder who has since left the community keeps their card until
    // an issuer acts on it, so a missing row falls back to `member` rather
    // than dropping the card out of this list.
    const roleRows = await this.members.find({
      where: { communityId, userId: In(cards.map((card) => card.userId)) },
    });
    const roleByUserId = new Map(
      roleRows.map((row) => [row.userId, row.role as string]),
    );

    // Per-CARD verification COUNTS, batched the same way. This roster is
    // already owner-or-mod gated, and a card verified far more often than the
    // rest of the roster is the leaked-or-shared-card signal. It stops at the
    // count: a "last verified at" beside a named holder's photo and pronouns
    // would be an attendance log for that person, so the query does not even
    // compute one. The programme-wide aggregate keeps its timestamp.
    const tallyByCardId = await this.scanLog.talliesForCards(
      cards.map((card) => card.id),
    );

    return cards.map((card) => {
      const profile = profileByUserId.get(card.userId);
      const tally = tallyByCardId.get(card.id);
      return toIssuerCard(
        card,
        program,
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
          pronouns: profile?.pronouns ?? null,
          role: roleByUserId.get(card.userId) ?? 'member',
          token: this.tokenFor(card),
          verificationCount: tally?.count ?? 0,
        },
      );
    });
  }
}
