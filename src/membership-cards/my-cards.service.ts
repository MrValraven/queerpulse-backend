import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { toVisibleAvatarUrl } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { effectiveCardStatus } from './card-status';
import { CardTokenService } from './card-token.service';
import { CommunityCard } from './entities/community-card.entity';
import { MyCardDTO, toMyCard } from './membership-card-response';
import { MembershipCardsService } from './membership-cards.service';

/**
 * Assembles a member's own cards. Batched on purpose: one query per table
 * rather than one per card, so a member holding ten cards costs the same
 * four round trips as a member holding one.
 */
@Injectable()
export class MyCardsService {
  constructor(
    private readonly cards: MembershipCardsService,
    private readonly tokens: CardTokenService,
    @InjectRepository(CommunityCard)
    private readonly programs: Repository<CommunityCard>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  /**
   * Never throws on an unconfigured platform. A missing signing key should cost
   * a member the code on their card, never their whole wallet page.
   */
  private tokenFor(card: { id: string; codeVersion: number }): string | null {
    if (!this.tokens.isConfigured) return null;
    return this.tokens.mint(card.id, card.codeVersion);
  }

  async forUser(userId: string): Promise<MyCardDTO[]> {
    const cards = await this.cards.cardsForUser(userId);
    if (cards.length === 0) return [];

    const programs = await this.programs.find({
      where: { id: In(cards.map((card) => card.programId)) },
    });
    const programById = new Map(programs.map((p) => [p.id, p]));

    const communities = await this.communities.find({
      where: { id: In(programs.map((p) => p.issuerId)) },
    });
    const communityById = new Map(communities.map((c) => [c.id, c]));

    const memberships = await this.members.find({
      where: { userId, communityId: In(communities.map((c) => c.id)) },
    });
    const roleByCommunity = new Map(
      memberships.map((m) => [m.communityId, m.role as string]),
    );

    // Display name lives on `Profile` (`firstName`/`lastName`), not `User`.
    // Null when there is no profile row or no name on it: the client prints
    // its own localized fallback.
    const profile = await this.profiles.findOne({ where: { userId } });
    const holderName = profile
      ? [profile.firstName, profile.lastName].filter(Boolean).join(' ') || null
      : null;
    // One avatar for every card the member holds, already through their
    // profile-wide "Show your photo" switch. The card is shown to other people
    // at a door, so it follows the same gate as the door and the issuer
    // roster, and the three always agree on whether the card carries a face.
    // Whether it reaches the wire is then decided per card in `toMyCard`,
    // which applies the programme's switch and the member's card veto.
    const holderAvatarUrl = toVisibleAvatarUrl(profile);
    // Read from the profile rather than stored per card, so a member who
    // changes their pronouns changes every card they hold at once. Whether it
    // reaches the wire is decided per card in `toMyCard`.
    const holderPronouns = profile?.pronouns ?? null;

    return cards.flatMap((card) => {
      const program = programById.get(card.programId);
      if (!program) return [];
      const community = communityById.get(program.issuerId);
      // An archived community 404s everywhere else, so its cards drop out of
      // the member's wallet rather than sitting there as dead objects.
      if (!community || community.archivedAt) return [];

      const status = effectiveCardStatus({
        status: card.status,
        expiresAt: card.expiresAt,
        programEnabled: program.isEnabled,
        communityFrozenAt: community.frozenAt,
        communityArchivedAt: community.archivedAt,
        // This is the holder's own wallet: it shows them their card as their
        // community holds it, so it does not gate on their own account.
        holderStatus: null,
      });

      return [
        toMyCard(card, program, status, {
          communityName: community.name,
          communitySlug: community.slug,
          role: roleByCommunity.get(community.id) ?? 'member',
          holderName,
          holderAvatarUrl,
          holderPronouns,
          token: this.tokenFor(card),
        }),
      ];
    });
  }
}
