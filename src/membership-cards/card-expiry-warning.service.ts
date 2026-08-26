import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, IsNull, Repository } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CARD_EXPIRY_WARNING_LEAD_DAYS,
  DAY_IN_MILLISECONDS,
  daysUntil,
} from './card-expiry';
import { CommunityCard } from './entities/community-card.entity';
import {
  MembershipCard,
  MembershipCardStatus,
} from './entities/membership-card.entity';

/**
 * How many cards one tick will warn about. A ceiling rather than a target: the
 * sweep is idempotent and daily, so a backlog larger than this simply drains
 * over the following nights instead of turning one cron tick into an unbounded
 * fan-out of notification writes.
 */
const MAX_WARNINGS_PER_RUN = 500;

/**
 * Tell a member their membership card is about to expire, while there is still
 * time to do something about it (SUS-07).
 *
 * The gap: a card expires on the programme's `validityMonths` clock and nothing
 * said so. The only route back in date was a community owner remembering to run
 * the roster bulk issue, so members found out their card was dead standing at a
 * door.
 *
 * IN-APP. QueerPulse sends no email and never will, so nothing here is
 * described as one and no copy promises a message on any other channel.
 *
 * ## Warning once, not every morning
 *
 * This is a DAILY cron and the window is thirty days wide, so the naive version
 * tells every member inside the window thirty times. The row is CLAIMED first
 * with a conditional UPDATE whose WHERE still carries
 * `expiry_warning_sent_at IS NULL` — exactly the shape
 * `AccountDeletionProcessorService.warnUpcomingDeletions` uses on
 * `deletion_request.final_warning_sent_at` — and a tick that loses the race
 * sees `affected === 0` and skips. Two replicas ticking at the same instant
 * therefore send once between them, not twice.
 *
 * Every path that puts a card back in date clears the marker
 * (`MembershipCardsService.issue`, `issueForRoster` and `renewOwnCard`), so the
 * NEXT term earns its own warning. The marker means "warned for this term",
 * never "warned once, ever".
 *
 * ## What is deliberately skipped
 *
 * A card an issuer suspended or revoked, a paused programme, and a frozen or
 * archived community are all filtered BEFORE the claim, not after. All four
 * already resolve the card to something other than "active" (see
 * `card-status.ts`), so a countdown would be telling the member the wrong
 * thing; and skipping before the claim leaves the marker null, so the warning
 * still arrives if the situation resolves while there is time.
 *
 * Errors are swallowed and logged: an escaping rejection from a
 * `@nestjs/schedule` handler becomes an unhandledRejection that can take the
 * process down, and the next tick retries.
 */
@Injectable()
export class CardExpiryWarningService {
  private readonly logger = new Logger(CardExpiryWarningService.name);

  constructor(
    @InjectRepository(MembershipCard)
    private readonly cards: Repository<MembershipCard>,
    @InjectRepository(CommunityCard)
    private readonly programs: Repository<CommunityCard>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async warnExpiringCards(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      this.logger.error(
        `Card expiry warning sweep failed: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
    }
  }

  private async sweep(): Promise<void> {
    const now = new Date();
    const horizon = new Date(
      now.getTime() + CARD_EXPIRY_WARNING_LEAD_DAYS * DAY_IN_MILLISECONDS,
    );

    // An expiry that has ALREADY passed belongs to nobody here: the card reads
    // "expired" on the member's own page, and a countdown to a moment in the
    // past is not a warning. The lower bound lives in the WHERE, because there
    // is no stored "expired" status: an out-of-date card keeps status =
    // 'active' with a NULL warning marker forever, so filtering these out in
    // JS let the oldest 500 dead rows occupy the whole batch every night and
    // starve every card that was genuinely about to lapse. A two-sided range
    // is still a single indexed range scan, so the bound costs nothing.
    const due = await this.cards.find({
      where: {
        status: MembershipCardStatus.Active,
        expiryWarningSentAt: IsNull(),
        expiresAt: Between(now, horizon),
      },
      order: { expiresAt: 'ASC' },
      take: MAX_WARNINGS_PER_RUN,
    });
    if (due.length === 0) return;

    // Two batched reads for the whole run, however many cards it holds.
    const programs = await this.programs.find({
      where: { id: In([...new Set(due.map((card) => card.programId))]) },
    });
    const programById = new Map(
      programs.map((program) => [program.id, program]),
    );
    const communities = await this.communities.find({
      where: { id: In([...new Set(programs.map((p) => p.issuerId))]) },
    });
    const communityById = new Map(
      communities.map((community) => [community.id, community]),
    );

    let warned = 0;
    for (const card of due) {
      const program = programById.get(card.programId);
      if (!program || !program.isEnabled) continue;
      const community = communityById.get(program.issuerId);
      if (!community || community.archivedAt || community.frozenAt) continue;

      const claim = await this.cards.update(
        {
          id: card.id,
          status: MembershipCardStatus.Active,
          expiryWarningSentAt: IsNull(),
        },
        { expiryWarningSentAt: now },
      );
      if (claim.affected !== 1) continue;

      // `expiresAt` is non-null for every card in `due` (the filter above
      // proved it), which is what lets this read it directly.
      const daysRemaining = daysUntil(card.expiresAt as Date, now);
      try {
        await this.notifications.create(
          card.userId,
          NotificationType.CardExpiring,
          {
            source: 'card',
            communitySlug: community.slug,
            communityName: community.name,
            daysRemaining,
            canSelfRenew: program.allowsSelfRenew,
          },
        );
        warned += 1;
      } catch (error) {
        // The claim stands. Dropping the marker so tomorrow's tick retries
        // would reopen the daily-repeat this column exists to close, and a
        // member who loses one warning still sees the expiry on their card.
        this.logger.warn(
          `Card expiry warning for card ${card.id} was claimed but not delivered: ${String(error)}`,
        );
      }
    }
    if (warned > 0) {
      this.logger.log(`Warned ${warned} member(s) of a card nearing expiry`);
    }
  }
}
