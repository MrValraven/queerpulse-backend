import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommunityGovernanceLogService } from '../communities/community-governance-log.service';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { Community } from '../communities/entities/community.entity';
import { GovernanceLogAction } from '../communities/entities/community-governance-log.entity';
import { CardSerialService } from './card-serial.service';
import { UpsertCardProgramDto } from './dto/upsert-card-program.dto';
import {
  CardIssuerType,
  CommunityCard,
} from './entities/community-card.entity';

/**
 * The card PROGRAMME: a community's decision to run a card at all, plus how
 * that card looks. Individual cards live in a later task's
 * `MembershipCardsService`.
 *
 * Phase 1 writes `CardIssuerType.Community` only. The polymorphic issuer
 * columns exist so Phase 2 can add collectives without a schema change.
 */
@Injectable()
export class CardProgramsService {
  constructor(
    @InjectRepository(CommunityCard)
    private readonly programs: Repository<CommunityCard>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly membership: CommunityMembershipService,
    private readonly serials: CardSerialService,
    private readonly governance: CommunityGovernanceLogService,
  ) {}

  async programForCommunity(
    communityId: string,
  ): Promise<CommunityCard | null> {
    return this.programs.findOne({
      where: { issuerType: CardIssuerType.Community, issuerId: communityId },
    });
  }

  async getBySlug(slug: string, userId: string): Promise<CommunityCard | null> {
    const communityId = await this.membership.assertMemberBySlug(slug, userId);
    return this.programForCommunity(communityId);
  }

  async upsert(
    slug: string,
    userId: string,
    dto: UpsertCardProgramDto,
  ): Promise<CommunityCard> {
    const communityId = await this.membership.assertOwnerOrModBySlug(
      slug,
      userId,
    );
    const community = await this.communities.findOne({
      where: { id: communityId },
    });
    // An archived community 404s everywhere else, and must not be able to
    // start issuing credentials from behind that takedown.
    if (!community || community.archivedAt) {
      throw new NotFoundException('Community not found');
    }

    const existing = await this.programForCommunity(communityId);
    const program =
      existing ??
      this.programs.create({
        issuerType: CardIssuerType.Community,
        issuerId: communityId,
        // Derived once and frozen: renaming the community must never
        // reissue anyone's serial.
        serialPrefix: this.serials.prefixFor(community.name),
      });

    program.isEnabled = dto.isEnabled;
    program.skin = dto.skin;
    program.accentToken = dto.accentToken;
    // Only touch the crest when the payload actually names it. `?? null`
    // unconditionally would clear an existing crest on every save that
    // simply omits the field — data loss the moment a crest-upload UI ships.
    // An explicit `null` still clears it; the field is only ever absent.
    if (dto.crestMediaKey !== undefined) {
      program.crestMediaKey = dto.crestMediaKey;
    }
    // The ground is ONE choice: a curated preset or an uploaded image, never
    // both. Setting either clears the other, so a programme can never hold two
    // grounds and leave the renderer to guess which wins. Same absent-vs-null
    // rule as the crest above: absent leaves it alone, null clears it.
    if (dto.backgroundPreset !== undefined) {
      program.backgroundPreset = dto.backgroundPreset;
      if (dto.backgroundPreset !== null) program.backgroundMediaKey = null;
    }
    if (dto.backgroundMediaKey !== undefined) {
      program.backgroundMediaKey = dto.backgroundMediaKey;
      if (dto.backgroundMediaKey !== null) program.backgroundPreset = null;
    }
    program.cardName = dto.cardName;
    program.validityMonths = dto.validityMonths ?? null;
    program.allowsPublicBadge = dto.allowsPublicBadge;
    // Same absent-vs-explicit rule as the crest and the ground above: only a
    // payload that actually names the field may change it.
    if (dto.allowsPrint !== undefined) {
      program.allowsPrint = dto.allowsPrint;
    }
    if (dto.allowsMemberPhoto !== undefined) {
      program.allowsMemberPhoto = dto.allowsMemberPhoto;
    }
    if (dto.photoStyle !== undefined) {
      program.photoStyle = dto.photoStyle;
    }
    if (dto.allowsPronouns !== undefined) {
      program.allowsPronouns = dto.allowsPronouns;
    }
    if (dto.textBackdrop !== undefined) {
      program.textBackdrop = dto.textBackdrop;
    }

    const saved = await this.programs.save(program);

    await this.governance.log({
      communityId,
      actorUserId: userId,
      action: dto.isEnabled
        ? GovernanceLogAction.CardProgramEnabled
        : GovernanceLogAction.CardProgramDisabled,
      metadata: { skin: dto.skin },
    });

    return saved;
  }
}
