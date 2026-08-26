import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { EffectiveCardStatus } from './card-status';
import { CardProgramsService } from './card-programs.service';
import {
  CardScanResult,
  MembershipCardScan,
} from './entities/membership-card-scan.entity';
import { MembershipCard } from './entities/membership-card.entity';
import {
  CardVerificationCountsDTO,
  toCardVerificationCounts,
} from './membership-card-response';

/** The window the issuer panel reports alongside the all-time total. */
export const CARD_VERIFICATION_RECENT_DAYS = 30;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The status a verifier saw, written down. Only the four statuses
 * `effectiveCardStatus` can produce are mapped: the other two `CardScanResult`
 * labels (`wrong_community`, `already_checked_in`) belong to a door check-in
 * that does not exist, and nothing here invents them.
 */
const SCAN_RESULT_BY_STATUS: Record<EffectiveCardStatus, CardScanResult> = {
  active: CardScanResult.Valid,
  expired: CardScanResult.Expired,
  revoked: CardScanResult.Revoked,
  suspended: CardScanResult.Suspended,
};

/** One card's usage, for the issuer's own roster row. */
/**
 * A COUNT AND NOTHING ELSE. The per-card tally used to carry a
 * `lastVerifiedAt` as well, and on a roster row that sits beside a named
 * member's photo and pronouns, a full timestamp of when they last presented
 * their card is an attendance log. The count is the leaked-or-shared-card
 * signal an issuer legitimately needs (a card checked far more often than the
 * rest of the roster); the minute it last happened is behavioural tracking of
 * a person, which this platform does not do. The programme-wide aggregate
 * (`CardVerificationCountsDTO`) keeps its `lastVerifiedAt`, because there it
 * is attributable to nobody.
 */
export interface CardScanTally {
  count: number;
}

/**
 * Operational and anti-fraud record-keeping for card verifications. This is
 * deliberately built so it cannot become behavioural analytics:
 *
 *  - A row is written ONLY once a signed token has resolved to a real card.
 *    An unsigned, forged or stale token writes nothing, so an unauthenticated
 *    caller cannot spam rows into this table by guessing.
 *  - No IP, no user agent, no geolocation, no fingerprint of whoever scanned.
 *    `scannedByUserId` stays null: the verify endpoint is public and has no
 *    caller identity to record.
 *  - There is deliberately NO "where has this member shown their card" query.
 *    The only reads offered here are an aggregate for one card programme and
 *    a per-CARD count for the issuer's own roster, which is the leaked-or-
 *    shared-card signal a card programme needs.
 *  - Rows are purged on a 90 day window by `CardScanRetentionService`.
 */
@Injectable()
export class CardScanLogService {
  private readonly logger = new Logger(CardScanLogService.name);

  constructor(
    private readonly membership: CommunityMembershipService,
    private readonly programs: CardProgramsService,
    @InjectRepository(MembershipCardScan)
    private readonly scans: Repository<MembershipCardScan>,
  ) {}

  /**
   * Write one row for a verification that resolved. Never throws and never
   * rejects, and the caller does not await it: a logging failure must cost the
   * verifier nothing, neither an error nor the latency of a second round trip
   * while a stranger stands at a door holding a card.
   */
  record(cardId: string, status: EffectiveCardStatus): void {
    const result = SCAN_RESULT_BY_STATUS[status];
    void this.scans
      .insert({ cardId, eventId: null, scannedByUserId: null, result })
      .catch((error: unknown) => {
        this.logger.warn(
          `Could not record a card verification for card ${cardId}: ${String(error)}`,
        );
      });
  }

  /**
   * The aggregate for one community's card programme. Owner or mod only,
   * enforced here the way every other issuer read in this module enforces it.
   *
   * Two numbers and a timestamp, and nothing that could reconstruct who showed
   * a card or where. A community with a programme but no verifications yet
   * gets zeroes rather than a 404: "nobody has checked a card yet" is a real
   * answer the panel should be able to state.
   */
  async countsForCommunity(
    slug: string,
    actorId: string,
  ): Promise<CardVerificationCountsDTO> {
    const communityId = await this.membership.assertOwnerOrModBySlug(
      slug,
      actorId,
    );
    const program = await this.programs.programForCommunity(communityId);
    if (!program) throw new NotFoundException('Card programme not found');

    const since = new Date(
      Date.now() - CARD_VERIFICATION_RECENT_DAYS * MILLISECONDS_PER_DAY,
    );
    const row = await this.scans
      .createQueryBuilder('scan')
      .innerJoin(MembershipCard, 'card', 'card.id = scan.card_id')
      .select('COUNT(*)', 'total')
      .addSelect('COUNT(*) FILTER (WHERE scan.scanned_at >= :since)', 'recent')
      .addSelect('MAX(scan.scanned_at)', 'lastVerifiedAt')
      .where('card.program_id = :programId', { programId: program.id })
      .setParameter('since', since)
      .getRawOne<{
        total: string | null;
        recent: string | null;
        lastVerifiedAt: Date | string | null;
      }>();

    return toCardVerificationCounts({
      total: Number(row?.total ?? 0),
      recent: Number(row?.recent ?? 0),
      recentDays: CARD_VERIFICATION_RECENT_DAYS,
      lastVerifiedAt: row?.lastVerifiedAt ?? null,
    });
  }

  /**
   * Per-card tallies for a roster whose caller has ALREADY been authorised to
   * read it. One grouped query for the whole roster rather than one per card,
   * matching the batching `CardHoldersService` already uses for profiles and
   * roles. A card nobody has ever verified is simply absent from the map.
   */
  async talliesForCards(
    cardIds: readonly string[],
  ): Promise<Map<string, CardScanTally>> {
    if (cardIds.length === 0) return new Map();
    const rows = await this.scans
      .createQueryBuilder('scan')
      .select('scan.card_id', 'cardId')
      .addSelect('COUNT(*)', 'count')
      .where('scan.card_id IN (:...cardIds)', { cardIds: [...cardIds] })
      .groupBy('scan.card_id')
      .getRawMany<{
        cardId: string;
        count: string;
      }>();

    return new Map(
      rows.map((row) => [row.cardId, { count: Number(row.count) }]),
    );
  }
}
