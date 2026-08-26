import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import {
  CommunitySupportOfferDTO,
  CommunitySupportOfferListDTO,
  toCommunitySupportOfferDTO,
} from './community-support-offers-response';
import { resolveStaffCommunity } from './community-staff-access';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
import { CommunityMember } from './entities/community-member.entity';
import {
  CommunitySupportOffer,
  CommunitySupportOfferStatus,
} from './entities/community-support-offer.entity';
import { Community } from './entities/community.entity';

/** The two answers a community's staff may give. `new` is the platform's to
 *  write, never the community's to set back. */
export type CommunitySupportOfferResponse =
  | CommunitySupportOfferStatus.Acknowledged
  | CommunitySupportOfferStatus.Declined;

/**
 * The community's own side of an offer of support: reading what platform staff
 * offered, and answering it.
 *
 * The admin write that creates these rows lives in
 * `AdminCommunitySupportService` (`src/admin-communities/`), where the rest of
 * the guarded admin writes against a community sit. This service deliberately
 * has no create path: a community cannot offer itself support.
 *
 * Gated the way every other staff-only community surface in this module is,
 * through `resolveStaffCommunity` — owner, co-owner or moderator, which is
 * exactly the set of people who were notified.
 */
/** One sentence for both the pre-check and the lost-race branch, so a
 *  moderator never learns which of the two answered them. */
const ALREADY_ANSWERED_MESSAGE = 'This offer has already been answered';

@Injectable()
export class CommunitySupportOffersService {
  private readonly logger = new Logger(CommunitySupportOffersService.name);

  constructor(
    @InjectRepository(CommunitySupportOffer)
    private readonly offers: Repository<CommunitySupportOffer>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly governanceLog: CommunityGovernanceLogService,
  ) {}

  /**
   * Every offer this community has been made, newest first, plus how many are
   * still unanswered so the mod-tools rail can badge the section.
   *
   * Unpaginated on purpose: an offer of support is a rare, staff-initiated
   * act, and a community that has been offered help enough times for this to
   * need paging has a different problem than a missing page control.
   */
  async listBySlug(
    slug: string,
    userId: string,
  ): Promise<CommunitySupportOfferListDTO> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      userId,
    );
    const rows = await this.offers.find({
      where: { communityId: community.id },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return {
      offers: await this.toDTOs(rows),
      openCount: rows.filter(
        (row) => row.status === CommunitySupportOfferStatus.New,
      ).length,
    };
  }

  /**
   * Answer one offer: take it up, or say it is not needed.
   *
   * Answering is one-way. An offer that has already been answered is refused
   * with a 400 rather than quietly overwritten, because the answer is a record
   * of what the community said at the time, and two moderators clicking
   * different buttons should not turn into a silent last-write-wins.
   *
   * Making that true takes a compare-and-set, the same shape
   * `VolunteeringService.decideSignup` and `common/queue-assignment.ts` use.
   * A read, a status check and a `save()` are three separate round trips with
   * nothing holding the row between them: two moderators pressing different
   * buttons in the same second both read `new`, both pass the check, and both
   * write. Last write wins silently, and worse, TWO contradictory
   * `support_offer_answered` entries land in a permanent governance log that
   * then contains both answers. `UPDATE ... WHERE id = :id AND status = 'new'`
   * lets exactly one of them affect a row; the other sees `affected === 0`
   * and gets the same 400 anyone answering an already-answered offer gets.
   * The governance-log write sits AFTER that check, so only the winner writes
   * one.
   */
  async respond(
    slug: string,
    userId: string,
    offerId: string,
    response: CommunitySupportOfferResponse,
  ): Promise<CommunitySupportOfferDTO> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      userId,
    );
    const offer = await this.offers.findOne({
      where: { id: offerId, communityId: community.id },
    });
    if (!offer) {
      throw new NotFoundException('Support offer not found');
    }
    // Fast path: the friendly 400 for the ordinary "someone already answered
    // this yesterday" case, without a pointless write.
    if (offer.status !== CommunitySupportOfferStatus.New) {
      throw new BadRequestException(ALREADY_ANSWERED_MESSAGE);
    }

    const respondedAt = new Date();
    const claim = await this.offers
      .createQueryBuilder()
      .update(CommunitySupportOffer)
      .set({ status: response, respondedByUserId: userId, respondedAt })
      .where('id = :id AND status = :new', {
        id: offer.id,
        new: CommunitySupportOfferStatus.New,
      })
      .execute();
    if (claim.affected === 0) {
      throw new BadRequestException(ALREADY_ANSWERED_MESSAGE);
    }
    // The in-memory row only now matches what is stored, and only on the
    // winning path.
    offer.status = response;
    offer.respondedByUserId = userId;
    offer.respondedAt = respondedAt;

    // Best effort after the answer has committed, the contract every logging
    // path in this module follows: a failed audit write must never be reported
    // to the moderator as a failed answer.
    try {
      await this.governanceLog.log({
        communityId: community.id,
        actorUserId: userId,
        action: GovernanceLogAction.SupportOfferAnswered,
        metadata: { offerId: offer.id, response },
      });
    } catch (error) {
      this.logger.warn(
        `Support offer ${offer.id} answered, but the governance-log entry could not be written: ${String(error)}.`,
      );
    }

    const [dto] = await this.toDTOs([offer]);
    return dto!;
  }

  /** Resolve both actor columns for a batch of rows in one profile query
   *  rather than one per row. */
  private async toDTOs(
    rows: CommunitySupportOffer[],
  ): Promise<CommunitySupportOfferDTO[]> {
    if (!rows.length) return [];
    const lookup = new MemberLookup(this.profiles);
    const userIds = [
      ...new Set(
        rows
          .flatMap((row) => [row.offeredByUserId, row.respondedByUserId])
          .filter((userId): userId is string => !!userId),
      ),
    ];
    const refs: Map<string, MemberRef> = await lookup.byUserIds(userIds);
    return rows.map((row) =>
      toCommunitySupportOfferDTO(
        row,
        row.offeredByUserId ? (refs.get(row.offeredByUserId) ?? null) : null,
        row.respondedByUserId
          ? (refs.get(row.respondedByUserId) ?? null)
          : null,
      ),
    );
  }
}
