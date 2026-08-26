import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { CommunityGovernanceLogService } from '../communities/community-governance-log.service';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { GovernanceLogAction } from '../communities/entities/community-governance-log.entity';
import { CardProgramsService } from './card-programs.service';
import { CardSerialService } from './card-serial.service';
import {
  CARD_EXPIRY_WARNING_LEAD_DAYS,
  isWithinRenewalWindow,
} from './card-expiry';
import { EffectiveCardStatus, effectiveCardStatus } from './card-status';
import { MAX_CODE_VERSION } from './card-token.service';
import { CommunityCard } from './entities/community-card.entity';
import {
  MembershipCard,
  MembershipCardStatus,
} from './entities/membership-card.entity';

const LEFT_COMMUNITY_REASON = 'Left the community';

// A concurrent `issue` for the same programme can 23505 on
// `UQ_membership_cards_serial` even though `CardSerialService.generate` did
// its own pre-check: the check and the insert are not atomic, so two
// requests can both pass the check with the same freshly-rolled serial. The
// unique index is the real backstop — retry with a freshly-generated serial
// rather than surfacing a 500.
const MAX_ISSUE_ATTEMPTS = 3;

/** What one bulk roster issue actually did, per member. */
export interface RosterIssueResult {
  /** Members who had no card at all and now hold one. */
  issued: number;
  /** Active cards whose expiry had already passed, put back in date. */
  renewed: number;
  /** Members holding a card an issuer suspended or revoked. Left untouched. */
  skipped: number;
  /** Members already holding a valid, in-date card. */
  unchanged: number;
}

@Injectable()
export class MembershipCardsService {
  constructor(
    @InjectRepository(MembershipCard)
    private readonly cards: Repository<MembershipCard>,
    @InjectRepository(CommunityCard)
    private readonly programRepo: Repository<CommunityCard>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly programs: CardProgramsService,
    private readonly serials: CardSerialService,
    private readonly membership: CommunityMembershipService,
    private readonly governance: CommunityGovernanceLogService,
  ) {}

  /**
   * Issue (or re-activate) one member's card. Idempotent by
   * (programId, userId), which the unique constraint also enforces: a member
   * who leaves and rejoins gets their original card and serial back rather
   * than a second row.
   */
  async issue(programId: string, userId: string): Promise<MembershipCard> {
    const program = await this.programRepo.findOne({
      where: { id: programId },
    });
    if (!program) throw new NotFoundException('Card programme not found');

    const existing = await this.cards.findOne({ where: { programId, userId } });
    if (existing && existing.status === MembershipCardStatus.Active) {
      return existing;
    }
    if (existing) {
      existing.status = MembershipCardStatus.Active;
      existing.revokedAt = null;
      existing.revokedReason = null;
      // Re-stamp the expiry on reactivation too. Without this, a member who
      // leaves and rejoins a community with `validityMonths` set gets their
      // old card back already expired — and an expired card has no issuer
      // action at all, so there would be no way back to a working card short
      // of deleting the row.
      existing.expiresAt = this.expiryFrom(program.validityMonths);
      // A fresh term earns a fresh warning. Leaving the marker set would mean
      // this card's next expiry arrived in silence.
      existing.expiryWarningSentAt = null;
      return this.cards.save(existing);
    }

    for (let attempt = 1; attempt <= MAX_ISSUE_ATTEMPTS; attempt += 1) {
      const card = this.cards.create({
        programId,
        userId,
        serial: await this.serials.generate(program.serialPrefix),
        status: MembershipCardStatus.Active,
        expiresAt: this.expiryFrom(program.validityMonths),
      });
      try {
        return await this.cards.save(card);
      } catch (error) {
        if (
          isUniqueViolation(error, 'UQ_membership_cards_serial') &&
          attempt < MAX_ISSUE_ATTEMPTS
        ) {
          continue;
        }
        throw error;
      }
    }
    // Unreachable: every loop iteration above either returns or throws.
    throw new Error('Could not issue membership card');
  }

  /**
   * Bulk issue to everyone currently on the roster.
   *
   * Deliberately NOT a call to `issue()` per member. `issue()` revives a
   * suspended or revoked card, which is right on the rejoin path (a member
   * who left had their card auto-revoked, and coming back should give it
   * back) and wrong here: anyone on the CURRENT roster holding a withdrawn
   * card had it withdrawn by an issuer, on purpose. Running this from the
   * card designer's Save used to hand every one of those cards back
   * silently. This skips them and reports the count instead, so the caller
   * can say what it did and did not do.
   *
   * An active card whose expiry has already passed IS renewed here: that is
   * the only route a community with `validityMonths` set has to put its
   * roster back in date.
   */
  async issueForRoster(programId: string): Promise<RosterIssueResult> {
    const result: RosterIssueResult = {
      issued: 0,
      renewed: 0,
      skipped: 0,
      unchanged: 0,
    };
    const program = await this.programRepo.findOne({
      where: { id: programId },
    });
    if (!program) return result;
    const communityId = program.issuerId;
    const roster = await this.members.find({ where: { communityId } });
    if (roster.length === 0) return result;

    const existingCards = await this.cards.find({
      where: { programId, userId: In(roster.map((member) => member.userId)) },
    });
    const cardByUserId = new Map(
      existingCards.map((card) => [card.userId, card]),
    );
    const now = Date.now();

    for (const member of roster) {
      const existing = cardByUserId.get(member.userId);
      if (!existing) {
        await this.issue(programId, member.userId);
        result.issued += 1;
        continue;
      }
      if (existing.status !== MembershipCardStatus.Active) {
        result.skipped += 1;
        continue;
      }
      if (existing.expiresAt && existing.expiresAt.getTime() <= now) {
        existing.expiresAt = this.expiryFrom(program.validityMonths);
        // Same reason as `issue()`: the new term gets its own T-30 warning.
        existing.expiryWarningSentAt = null;
        await this.cards.save(existing);
        result.renewed += 1;
        continue;
      }
      result.unchanged += 1;
    }
    return result;
  }

  async setStatus(
    slug: string,
    actorId: string,
    cardId: string,
    status: 'active' | 'suspended' | 'revoked',
    reason?: string,
  ): Promise<MembershipCard> {
    const communityId = await this.membership.assertOwnerOrModBySlug(
      slug,
      actorId,
    );
    const program = await this.programs.programForCommunity(communityId);
    if (!program) throw new NotFoundException('Card programme not found');

    // Scoping the lookup by programId is what stops a mod of community A
    // revoking a card issued by community B.
    const card = await this.cards.findOne({
      where: { id: cardId, programId: program.id },
    });
    if (!card) throw new NotFoundException('Card not found');

    if (status !== 'active' && !reason) {
      throw new BadRequestException(
        'A reason is required to suspend or revoke a card',
      );
    }

    if (status === 'active') {
      card.status = MembershipCardStatus.Active;
      card.revokedAt = null;
      card.revokedReason = null;
    } else if (status === 'suspended') {
      card.status = MembershipCardStatus.Suspended;
      card.revokedReason = reason ?? null;
    } else {
      card.status = MembershipCardStatus.Revoked;
      card.revokedAt = new Date();
      card.revokedReason = reason ?? null;
    }

    const saved = await this.cards.save(card);
    await this.governance.log({
      communityId,
      actorUserId: actorId,
      action:
        status === 'active'
          ? GovernanceLogAction.CardReinstated
          : status === 'suspended'
            ? GovernanceLogAction.CardSuspended
            : GovernanceLogAction.CardRevoked,
      targetUserId: card.userId,
      metadata: { serial: card.serial },
    });
    return saved;
  }

  /**
   * Void every printed copy of one card without touching the holder's digital
   * card.
   *
   * This is the "my wallet was stolen" remedy, and it is deliberately a
   * different act from reinstating. Reinstating revives the same row and
   * therefore the same permanent code, which is right when a revocation was a
   * mistake and wrong when the physical object is gone. Bumping the generation
   * leaves status, serial and dates exactly as they were, so the member stays
   * a member throughout and their card on their phone simply starts showing a
   * new code.
   */
  async replaceCode(
    slug: string,
    actorId: string,
    cardId: string,
  ): Promise<MembershipCard> {
    const communityId = await this.membership.assertOwnerOrModBySlug(
      slug,
      actorId,
    );
    const program = await this.programs.programForCommunity(communityId);
    if (!program) throw new NotFoundException('Card programme not found');

    // Scoped by programId for the same reason `setStatus` is: it stops a mod
    // of community A acting on a card issued by community B.
    const card = await this.cards.findOne({
      where: { id: cardId, programId: program.id },
    });
    if (!card) throw new NotFoundException('Card not found');

    // The code carries a uint16 generation. Guarded here so the ceiling is a
    // clear 400 rather than a signing error sixty-five thousand replacements
    // from now.
    if (card.codeVersion >= MAX_CODE_VERSION) {
      throw new BadRequestException(
        'This card has been replaced too many times',
      );
    }

    card.codeVersion += 1;
    const saved = await this.cards.save(card);
    await this.governance.log({
      communityId,
      actorUserId: actorId,
      action: GovernanceLogAction.CardReplaced,
      targetUserId: card.userId,
      metadata: { serial: card.serial, codeVersion: card.codeVersion },
    });
    return saved;
  }

  /**
   * Auto-revoke when someone leaves or is removed from the roster. Silent
   * when the community runs no programme. Leaving the card active would let a
   * former member keep proving a membership they no longer hold.
   */
  async revokeForUser(communityId: string, userId: string): Promise<void> {
    const program = await this.programs.programForCommunity(communityId);
    if (!program) return;
    const card = await this.cards.findOne({
      where: { programId: program.id, userId },
    });
    if (!card || card.status === MembershipCardStatus.Revoked) return;
    card.status = MembershipCardStatus.Revoked;
    card.revokedAt = new Date();
    card.revokedReason = LEFT_COMMUNITY_REASON;
    await this.cards.save(card);
  }

  async cardsForUser(userId: string): Promise<MembershipCard[]> {
    return this.cards.find({
      where: { userId },
      order: { issuedAt: 'DESC' },
    });
  }

  async cardsForProgram(programId: string): Promise<MembershipCard[]> {
    return this.cards.find({
      where: { programId },
      order: { issuedAt: 'DESC' },
    });
  }

  async cardById(cardId: string): Promise<MembershipCard | null> {
    return this.cards.findOne({ where: { id: cardId } });
  }

  /**
   * The status a verifier would see for this card right now: its own status
   * combined with the issuing programme/community's lifecycle and the expiry
   * clock (see `card-status.ts`). Returns null if the card's programme or
   * community row can no longer be resolved — treat that the same as "not
   * usable".
   *
   * `MyCardsService.forUser` does this same resolution batched across many
   * cards; this is the single-card version for a caller (like
   * `MembershipCardsController.token()`) that only has one card in hand and
   * must not mint a fresh signed token for anything but an active one.
   */
  async resolveEffectiveStatus(
    card: MembershipCard,
  ): Promise<EffectiveCardStatus | null> {
    const program = await this.programRepo.findOne({
      where: { id: card.programId },
    });
    if (!program) return null;
    const community = await this.communities.findOne({
      where: { id: program.issuerId },
    });
    if (!community) return null;
    return effectiveCardStatus({
      status: card.status,
      expiresAt: card.expiresAt,
      programEnabled: program.isEnabled,
      communityFrozenAt: community.frozenAt,
      communityArchivedAt: community.archivedAt,
    });
  }

  /**
   * Hard-deletes a card the caller holds (spec §K.4: the member's right to
   * have a card destroyed, not only revoked). 404s — never 403s — for a card
   * the caller does not hold, matching the non-disclosure posture the token
   * route already uses: a caller must never learn that a card id exists
   * under someone else's account.
   */
  /**
   * Set the member's photo veto on a card they HOLD.
   *
   * Deliberately allowed on a card of ANY status. A suspended or expired card
   * can come back (see the note in `MyCardsPage` on why only revoked and
   * expired are offered for destruction), and a member who wants their face
   * off a credential should not have to wait for the issuer to reinstate it
   * first. Same 404-not-403 rule as everything else here: a caller who does
   * not hold the card learns nothing about whether it exists.
   */
  async updateOwnCardSettings(
    cardId: string,
    userId: string,
    settings: { isPhotoHidden?: boolean; isPronounsHidden?: boolean },
  ): Promise<void> {
    const card = await this.cards.findOne({ where: { id: cardId } });
    if (!card || card.userId !== userId) {
      throw new NotFoundException('Card not found');
    }
    // Only the fields the payload actually named, and only where they differ,
    // so toggling one veto never rewrites the other and a no-op save costs no
    // write. The ownership check above runs whether or not anything changes:
    // a caller who does not hold the card gets the same 404 either way.
    const patch: Partial<MembershipCard> = {};
    if (
      settings.isPhotoHidden !== undefined &&
      settings.isPhotoHidden !== card.isPhotoHidden
    ) {
      patch.isPhotoHidden = settings.isPhotoHidden;
    }
    if (
      settings.isPronounsHidden !== undefined &&
      settings.isPronounsHidden !== card.isPronounsHidden
    ) {
      patch.isPronounsHidden = settings.isPronounsHidden;
    }
    if (Object.keys(patch).length === 0) return;
    await this.cards.update(card.id, patch);
  }

  /**
   * Put the caller's OWN card back in date, without an owner running the
   * roster bulk issue (SUS-07).
   *
   * The distinction `issueForRoster` draws is preserved here exactly, and
   * tightened. That method renews an ACTIVE card whose term has run out and
   * deliberately skips a suspended or revoked one, because an issuer withdrew
   * those on purpose. A member may not undo an issuer's decision at all, so a
   * withdrawn card is refused here rather than skipped, with a reason code the
   * UI can turn into a sentence.
   *
   * Roster membership is read LIVE, never inferred from the card's existence:
   * a member who has left keeps their row until an issuer or the leave hook
   * revokes it, and none of that may become a route back to a working
   * credential. The programme's own `allowsSelfRenew` switch is checked here
   * too, so a community that never opted in cannot have its cards renewed by
   * a client that guessed the URL.
   *
   * Idempotent and concurrency-safe. The write is a compare-and-set: the WHERE
   * still carries the status and the exact `expiresAt` this method read, so two
   * requests racing produce ONE renewal and the loser returns the card as it
   * now stands rather than stamping a second term on top of the first.
   *
   * Reuses `expiryFrom`, so a renewed card and a freshly issued one get their
   * term from the same clock.
   */
  async renewOwnCard(
    cardId: string,
    userId: string,
  ): Promise<{ card: MembershipCard; effectiveStatus: EffectiveCardStatus }> {
    // 404, never 403, for a card the caller does not hold: the same
    // non-disclosure posture `deleteOwnCard` and the token route use, so a
    // caller can never learn that a card id exists under someone else's
    // account.
    const card = await this.cards.findOne({ where: { id: cardId } });
    if (!card || card.userId !== userId) {
      throw new NotFoundException('Card not found');
    }
    const program = await this.programRepo.findOne({
      where: { id: card.programId },
    });
    if (!program) throw new NotFoundException('Card not found');
    const community = await this.communities.findOne({
      where: { id: program.issuerId },
    });
    // An archived community 404s everywhere else and must not be able to hand
    // out a fresh term from behind that takedown.
    if (!community || community.archivedAt) {
      throw new NotFoundException('Card not found');
    }

    if (!program.allowsSelfRenew) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'This community renews its own cards',
        reasonCode: 'self_renew_not_allowed',
      });
    }
    // An issuer withdrew this one deliberately. Only an issuer can undo it.
    if (card.status !== MembershipCardStatus.Active) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'This card was withdrawn by its community',
        reasonCode: 'card_withdrawn',
      });
    }
    // Live roster membership, read now rather than trusted from the card row.
    const isStillOnRoster = await this.membership.isMember(
      program.issuerId,
      userId,
    );
    if (!isStillOnRoster) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'You are no longer a member of this community',
        reasonCode: 'not_a_member',
      });
    }
    // A paused programme or a frozen community resolves every card to
    // "suspended" (see card-status.ts). Renewing under either would mint a term
    // on a credential that still cannot prove anything.
    if (!program.isEnabled || community.frozenAt) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'This card programme is paused',
        reasonCode: 'programme_paused',
      });
    }
    if (card.expiresAt === null || program.validityMonths === null) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'This card does not expire',
        reasonCode: 'no_expiry',
      });
    }
    // Open from the same moment the T-30 warning goes out, and no earlier: the
    // bell that says "renew it" must never arrive before the button works, and
    // a member must not be able to ratchet their term forward every morning.
    if (!isWithinRenewalWindow(card.expiresAt)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: `This card can be renewed in its last ${CARD_EXPIRY_WARNING_LEAD_DAYS} days`,
        reasonCode: 'not_due',
      });
    }

    await this.cards.update(
      {
        id: card.id,
        userId,
        status: MembershipCardStatus.Active,
        // The compare half of the compare-and-set. A row whose expiry has
        // already moved is a row somebody else renewed, and this update
        // matches nothing.
        expiresAt: card.expiresAt,
      },
      {
        expiresAt: this.expiryFrom(program.validityMonths),
        // The new term earns its own warning.
        expiryWarningSentAt: null,
      },
    );
    // Whether this request won the race or lost it, the answer is the same:
    // the card as it now stands. A loser returning the winner's term is what
    // makes this idempotent, so `affected` is deliberately not treated as an
    // error. Retrying a renew that already happened must never stack a second
    // term on top of the first, and must never read as a failure either.
    const renewed = await this.cardById(card.id);
    if (!renewed) throw new NotFoundException('Card not found');
    return {
      card: renewed,
      effectiveStatus: effectiveCardStatus({
        status: renewed.status,
        expiresAt: renewed.expiresAt,
        programEnabled: program.isEnabled,
        communityFrozenAt: community.frozenAt,
        communityArchivedAt: community.archivedAt,
      }),
    };
  }

  async deleteOwnCard(cardId: string, userId: string): Promise<void> {
    const card = await this.cards.findOne({ where: { id: cardId } });
    if (!card || card.userId !== userId) {
      throw new NotFoundException('Card not found');
    }
    await this.cards.delete(card.id);
  }

  private expiryFrom(validityMonths: number | null): Date | null {
    if (validityMonths === null) return null;
    const expiry = new Date(Date.now());
    expiry.setUTCMonth(expiry.getUTCMonth() + validityMonths);
    return expiry;
  }

  private async programIssuerId(programId: string): Promise<string | null> {
    const program = await this.programRepo.findOne({
      where: { id: programId },
    });
    return program?.issuerId ?? null;
  }
}
