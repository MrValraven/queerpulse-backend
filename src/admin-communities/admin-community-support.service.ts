import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { MemberLookup } from '../common/member-ref';
import { toStoredPlainTextOrNull } from '../communities/community-plain-text';
import { CommunityGovernanceLogService } from '../communities/community-governance-log.service';
import {
  COMMUNITY_STAFF_ROLES,
  loadActiveCommunityOr404,
} from '../communities/community-staff-access';
import {
  CommunitySupportOfferDTO,
  toCommunitySupportOfferDTO,
} from '../communities/community-support-offers-response';
import { GovernanceLogAction } from '../communities/entities/community-governance-log.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import {
  CommunitySupportOffer,
  CommunitySupportOfferStatus,
} from '../communities/entities/community-support-offer.entity';
import { Community } from '../communities/entities/community.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { CreateCommunitySupportOfferDto } from './dto/create-community-support-offer.dto';

/**
 * Platform staff offering a struggling community a hand (OPS-05).
 *
 * The admin health modal has had an "Offer support" button since the console
 * was built, and until now it wrote nothing: a success toast, an Undo that
 * withdrew nothing, and a community that never heard from anyone. This is the
 * write behind it.
 *
 * The act is supportive rather than a sanction, which is why it sits on a
 * controller carrying the delegated `communities` grant alongside moderator
 * appointment, and not with the admin-only moderation-of-last-resort
 * overrides (freeze, archive, reassign ownership).
 *
 * It still goes in the community's governance log. Everything platform staff
 * do TO a community is recorded there, and "a stranger from the platform
 * turned up offering to sit with our moderators for two weeks" is exactly the
 * kind of thing a community's own history should be able to answer later.
 */
/** The partial unique index behind "one unanswered offer per community", from
 *  `1795700000000-AddCommunitySupportOfferOpenUniqueIndex.ts`. Named here so
 *  the catch below cannot mistake some other unique violation for this one. */
const OPEN_OFFER_UNIQUE_INDEX = 'UQ_community_support_offers_open';

/** One sentence for both the pre-check and the lost-race catch, so a staff
 *  member never learns which of the two answered them. */
const ALREADY_OFFERED_MESSAGE =
  'This community already has an offer of support waiting for an answer';

@Injectable()
export class AdminCommunitySupportService {
  private readonly logger = new Logger(AdminCommunitySupportService.name);

  constructor(
    @InjectRepository(CommunitySupportOffer)
    private readonly offers: Repository<CommunitySupportOffer>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly notifications: NotificationsService,
    private readonly governanceLog: CommunityGovernanceLogService,
  ) {}

  /**
   * Write one offer, then tell the community's owner, co-owners and
   * moderators about it.
   *
   * A community may hold only one UNANSWERED offer at a time (409 otherwise).
   * Without that, an admin clicking twice, or two staff members reaching for
   * the same struggling room in the same week, buries the moderators under
   * duplicate offers of the same four things. Once the community has answered,
   * a fresh offer is allowed.
   *
   * That invariant is enforced in TWO places, and it needs both. The
   * `exists(...)` pre-check is the fast path: it produces the friendly 409 for
   * the common case without reaching the table's write path. It is also, on
   * its own, a read-then-write with nothing between the two calls, so a
   * double-click or two staff members in the same second both read `false` and
   * both insert. The partial unique index
   * `UQ_community_support_offers_open` (migration `1795700000000`) is what
   * actually closes that window, and the loser's 23505 is caught below and
   * mapped to the same ConflictException the pre-check throws, so both racers
   * see one consistent answer.
   */
  async create(
    slug: string,
    staffUserId: string,
    dto: CreateCommunitySupportOfferDto,
  ): Promise<CommunitySupportOfferDTO> {
    const community = await loadActiveCommunityOr404(this.communities, slug);

    const isAlreadyOffered = await this.offers.exists({
      where: {
        communityId: community.id,
        status: CommunitySupportOfferStatus.New,
      },
    });
    if (isAlreadyOffered) {
      throw new ConflictException(ALREADY_OFFERED_MESSAGE);
    }

    const lookup = new MemberLookup(this.profiles);
    const staffRefs = await lookup.byUserIds([staffUserId]);
    const staffRef = staffRefs.get(staffUserId) ?? null;
    const offeredByName = staffRef
      ? `${staffRef.firstName} ${staffRef.lastName}`.trim() || null
      : null;

    let offer: CommunitySupportOffer;
    try {
      offer = await this.offers.save(
        this.offers.create({
          communityId: community.id,
          offeredByUserId: staffUserId,
          offeredByName,
          options: dto.options,
          // Stripped once, here at the write boundary, so the column can never
          // hold markup and no render site has to strip it again.
          note: toStoredPlainTextOrNull(dto.note),
          status: CommunitySupportOfferStatus.New,
          respondedByUserId: null,
          respondedAt: null,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error, OPEN_OFFER_UNIQUE_INDEX)) {
        throw new ConflictException(ALREADY_OFFERED_MESSAGE);
      }
      throw error;
    }

    await this.writeGovernanceLog(community.id, staffUserId, offer);
    await this.notifyCommunityStaff(community, staffUserId);

    return toCommunitySupportOfferDTO(offer, staffRef, null);
  }

  /**
   * Best effort, after the offer has already committed — the contract every
   * logging path against a community follows. A failed audit write must never
   * be reported to the staff member as a failed offer.
   */
  private async writeGovernanceLog(
    communityId: string,
    staffUserId: string,
    offer: CommunitySupportOffer,
  ): Promise<void> {
    try {
      await this.governanceLog.log({
        communityId,
        actorUserId: staffUserId,
        action: GovernanceLogAction.SupportOffered,
        metadata: {
          offerId: offer.id,
          options: offer.options,
          adminOverride: true,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Support offered to community ${communityId}, but the governance-log entry could not be written: ${String(error)}.`,
      );
    }
  }

  /**
   * The people who actually run the room: the owner of record plus every
   * owner/co-owner/mod on the roster. Resolved exactly the way
   * `ReportNotificationsListener.notifyCommunityStaff` resolves the same
   * audience.
   *
   * IN-APP is the channel. QueerPulse sends no email, so nothing here or in
   * the copy behind this type may suggest one is on the way.
   *
   * No `actorId` is passed and none goes in the payload. This is the platform
   * speaking to a community's staff, and a moderator's personal block of the
   * staff member who happened to write the offer must not be able to swallow
   * it. The pane names who offered, read under the moderator's own
   * authentication.
   *
   * Best effort in its own try/catch: the offer row is the record, and a
   * notification failure must not be reported as a failed offer.
   */
  private async notifyCommunityStaff(
    community: Community,
    staffUserId: string,
  ): Promise<void> {
    try {
      const roster = await this.members.find({
        where: {
          communityId: community.id,
          role: In([...COMMUNITY_STAFF_ROLES]),
        },
        select: { userId: true },
      });
      const recipientIds = [
        ...new Set(
          [community.ownerId, ...roster.map((row) => row.userId)].filter(
            (userId): userId is string => !!userId,
          ),
        ),
      ].filter((userId) => userId !== staffUserId);
      if (!recipientIds.length) return;

      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.CommunitySupportOffered,
        {
          source: 'community',
          communitySlug: community.slug,
          communityName: community.name,
        },
      );
    } catch (error) {
      this.logger.error(
        `Support offered to community ${community.id}, but notifying its staff failed: ${String(error)}`,
      );
    }
  }
}
