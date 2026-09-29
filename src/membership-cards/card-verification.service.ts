import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { toVisibleAvatarUrl } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { CardScanLogService } from './card-scan-log.service';
import { effectiveCardStatus } from './card-status';
import { CardTokenService } from './card-token.service';
import { CommunityCard } from './entities/community-card.entity';
import {
  CardVerificationDTO,
  toCardVerification,
} from './membership-card-response';
import { MembershipCardsService } from './membership-cards.service';

/**
 * Resolves a scanned card token to the public verification payload.
 *
 * Returns null for EVERY failure: bad signature, expired token, missing
 * card, missing programme, missing community. A caller cannot tell those
 * apart, so a scanned QR either resolves to a card or it does not, and
 * nothing about the platform's card population leaks through the
 * difference.
 *
 * Name fields (`firstName`/`lastName`) live on `Profile`, since the `users`
 * table carries no display name, only auth/status columns. This
 * reads `Profile` (primary key `user_id`) and joins its `user` for the one
 * auth column the door needs, the holder's account status.
 */
@Injectable()
export class CardVerificationService {
  constructor(
    private readonly tokens: CardTokenService,
    private readonly cards: MembershipCardsService,
    private readonly scanLog: CardScanLogService,
    @InjectRepository(CommunityCard)
    private readonly programs: Repository<CommunityCard>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  async verify(token: string): Promise<CardVerificationDTO | null> {
    const payload = this.tokens.verify(token);
    if (!payload) return null;

    const card = await this.cards.cardById(payload.cardId);
    if (!card) return null;

    // The generation check. A card whose issuer has replaced it keeps its row,
    // its status and its serial, and every printed copy of the previous code
    // stops resolving here.
    if (card.codeVersion !== payload.codeVersion) return null;

    const program = await this.programs.findOne({
      where: { id: card.programId },
    });
    if (!program) return null;

    const community = await this.communities.findOne({
      where: { id: program.issuerId },
    });
    if (!community) return null;

    // Read before the status, because the holder's account is part of it: a
    // member suspended by moderation, or one who has paused or is deleting
    // their account, must not present a card that reads "Valid" at a door.
    const holder = await this.profiles.findOne({
      where: { userId: card.userId },
      relations: { user: true },
    });

    const status = effectiveCardStatus({
      status: card.status,
      expiresAt: card.expiresAt,
      programEnabled: program.isEnabled,
      communityFrozenAt: community.frozenAt,
      communityArchivedAt: community.archivedAt,
      holderStatus: holder?.user?.status ?? null,
    });

    // The one place a verification becomes a record. It sits AFTER the token
    // has resolved to a real card of the right generation, so a forged,
    // unsigned or stale code writes nothing and an unauthenticated caller has
    // no way to put rows in this table. It records the outcome, so an expired
    // or revoked presentation is distinguishable in the issuer's log while the
    // HTTP response stays the same single 404 for every failure.
    //
    // Not awaited, and it cannot reject: a logging failure must never break
    // the verification or make a stranger at a door wait for a second write.
    this.scanLog.record(card.id, status);

    const membership = await this.members.findOne({
      where: { communityId: community.id, userId: card.userId },
    });

    // The holder's profile-wide "Show your photo" switch, through the same
    // gate the issuer roster applies, so the door and the roster agree: once
    // the switch is off, neither shows the face.
    const visibleAvatarUrl = toVisibleAvatarUrl(holder);

    return toCardVerification(card, status, {
      issuerName: community.name,
      // Null for a holder with no profile row, or with no name on it. The
      // client prints its own localized fallback for that case.
      holderName: holder
        ? [holder.firstName, holder.lastName].filter(Boolean).join(' ') || null
        : null,
      role: membership?.role ?? 'member',
      // Four conditions, all of which must hold for a face to be on the card:
      // the programme prints photos, the member has not vetoed theirs on this
      // card, their profile photo is visible, and they actually have one.
      hasPhoto:
        program.allowsMemberPhoto &&
        !card.isPhotoHidden &&
        Boolean(visibleAvatarUrl),
      // Three matching conditions applied to the other thing the card can say
      // about its holder: the programme prints pronouns, the member has not
      // vetoed theirs, and they have any set. A stranger learns exactly what
      // the card in their hand says and nothing beyond it.
      holderPronouns:
        program.allowsPronouns && !card.isPronounsHidden
          ? holder?.pronouns?.trim() || null
          : null,
      // Already resolved and `photoVisible`-gated; `toCardVerification`
      // applies the card's photo gate and the status gate on top, so there is
      // exactly one place a face can leave through.
      holderAvatarUrl: visibleAvatarUrl,
      photoStyle: program.photoStyle,
    });
  }
}
