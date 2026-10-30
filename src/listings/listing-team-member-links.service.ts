import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, In } from 'typeorm';
import { MediaCropService } from '../media-crops/media-crops.service';
import {
  ListingTeamInitiator,
  ListingTeamMember,
  ListingTeamMemberStatus,
} from './entities/listing-team-member.entity';
import { Listing } from './entities/listing.entity';
import { listingCardPhotoKeys } from './listing-response';
import {
  LISTING_TEAM_SEARCH,
  listingTeamError,
} from './listing-team.constants';
import {
  LISTING_TEAM_MEMBER_ACCEPTED,
  type ListingTeamMemberAlertEvent,
} from './listing-team.events';
import {
  LISTING_TEAM_LISTING_COLUMNS,
  toListingTeamListing,
  toListingTeamPersonaRow,
  type ListingTeamMemberLinkList,
  type ListingTeamMemberLinkRow,
} from './listing-team-response';
import {
  eligibleMemberSql,
  publiclyVisibleListingSql,
} from './listing-team-visibility';
import {
  assertMemberAcceptedRoom,
  hasBlockEitherWay,
  lockListingRow,
  lockMemberCap,
  lockTeamRow,
  nextTeamPosition,
  readListingFacts,
} from './listing-team-write-rules';

/**
 * The team row columns the list reads select. The privacy guarantee comes
 * from the explicit mapper `toListingTeamPersonaRow`, which copies named
 * fields alone: `userId` and `requestedByUserId` never reach a shape built
 * here.
 */
const TEAM_ROW_COLUMNS = {
  id: true,
  listingId: true,
  userId: true,
  roleLabel: true,
  status: true,
  initiatedBy: true,
  answeredAt: true,
  position: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The member side of "Meet the team": the invites a member received from
 * listings and the teams they belong to. The caller is the member, so no
 * persona seat is involved. A row that is not the caller's, a row that is not
 * a member row and an unknown id all answer the same 404.
 *
 * Writes take their locks in the shared order (listing row, team row, then
 * the member's cap lock) at the default READ COMMITTED isolation, and the
 * alert goes out only after the transaction commits.
 */
@Injectable()
export class ListingTeamMemberLinksService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly mediaCropService: MediaCropService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async list(userId: string): Promise<ListingTeamMemberLinkList> {
    const manager = this.dataSource.manager;
    const invitesWhere = {
      userId,
      status: ListingTeamMemberStatus.Pending,
      initiatedBy: ListingTeamInitiator.Listing,
    };
    const [invitesReceived, awaitingYouCount, accepted] = await Promise.all([
      manager.find(ListingTeamMember, {
        select: TEAM_ROW_COLUMNS,
        where: invitesWhere,
        order: { createdAt: 'DESC', id: 'DESC' },
        take: LISTING_TEAM_SEARCH.invitesReceivedMax,
      }),
      manager.count(ListingTeamMember, { where: invitesWhere }),
      manager.find(ListingTeamMember, {
        select: TEAM_ROW_COLUMNS,
        where: { userId, status: ListingTeamMemberStatus.Accepted },
        order: { answeredAt: 'ASC', id: 'ASC' },
      }),
    ]);
    const buildRows = await this.rowBuilder(manager, [
      ...invitesReceived,
      ...accepted,
    ]);
    return {
      awaitingYouCount,
      invitesReceived: buildRows(invitesReceived),
      accepted: buildRows(accepted),
    };
  }

  async accept(
    userId: string,
    linkId: string,
  ): Promise<ListingTeamMemberLinkRow> {
    const committed = await this.dataSource.transaction(
      async (manager): Promise<ListingTeamMember> => {
        // An unlocked read learns the row's listing, so the listing row can
        // be locked ahead of the team row.
        const located = await manager.findOne(ListingTeamMember, {
          select: { id: true, listingId: true, userId: true },
          where: { id: linkId },
        });
        if (!located || located.userId !== userId) {
          throw listingTeamError('listing_team_link_not_found');
        }
        await lockListingRow(manager, located.listingId);
        const member = await lockTeamRow(manager, linkId);
        if (
          !member ||
          member.userId !== userId ||
          member.listingId !== located.listingId ||
          member.initiatedBy !== ListingTeamInitiator.Listing
        ) {
          throw listingTeamError('listing_team_link_not_found');
        }
        if (member.status !== ListingTeamMemberStatus.Pending) {
          throw listingTeamError('listing_team_not_pending');
        }
        await lockMemberCap(manager, userId);
        const listing = await readListingFacts(manager, member.listingId);
        if (
          !listing ||
          (await hasBlockEitherWay(manager, userId, listing.ownerUserId))
        ) {
          throw listingTeamError('listing_team_link_not_found');
        }
        if (!listing.isPubliclyVisible) {
          throw listingTeamError('listing_team_listing_not_live');
        }
        if (!(await this.isMemberEligible(manager, userId))) {
          throw listingTeamError('listing_team_member_ineligible');
        }
        await assertMemberAcceptedRoom(manager, member.listingId, userId);
        const position = await nextTeamPosition(manager, member.listingId);
        const answeredAt = new Date();
        await manager.update(
          ListingTeamMember,
          { id: member.id },
          { status: ListingTeamMemberStatus.Accepted, position, answeredAt },
        );
        member.status = ListingTeamMemberStatus.Accepted;
        member.position = position;
        member.answeredAt = answeredAt;
        return member;
      },
    );
    const event: ListingTeamMemberAlertEvent = {
      memberId: committed.id,
      actingUserId: userId,
    };
    this.eventEmitter.emit(LISTING_TEAM_MEMBER_ACCEPTED, event);
    return this.toRow(committed);
  }

  /** Says no to a listing's invite. Quiet; starts that listing's cooldown. */
  async decline(userId: string, linkId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const member = await lockTeamRow(manager, linkId);
      if (
        !member ||
        member.userId !== userId ||
        member.initiatedBy !== ListingTeamInitiator.Listing
      ) {
        throw listingTeamError('listing_team_link_not_found');
      }
      if (member.status !== ListingTeamMemberStatus.Pending) {
        throw listingTeamError('listing_team_not_pending');
      }
      await manager.update(
        ListingTeamMember,
        { id: member.id },
        { status: ListingTeamMemberStatus.Declined, answeredAt: new Date() },
      );
    });
  }

  /** Steps the member off an accepted team. Quiet. */
  async leave(userId: string, linkId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const member = await lockTeamRow(manager, linkId);
      if (!member || member.userId !== userId) {
        throw listingTeamError('listing_team_link_not_found');
      }
      if (member.status !== ListingTeamMemberStatus.Accepted) {
        throw listingTeamError('listing_team_not_accepted');
      }
      await manager.update(
        ListingTeamMember,
        { id: member.id },
        { status: ListingTeamMemberStatus.Left, position: null },
      );
    });
  }

  /**
   * True when the member's account is active and their profile is open, not
   * self-hidden and not taken down. A member without a profile row is not
   * eligible.
   */
  private async isMemberEligible(
    manager: EntityManager,
    userId: string,
  ): Promise<boolean> {
    const rows = await manager.query<{ is_eligible: boolean }[]>(
      `SELECT (${eligibleMemberSql('member_profile', 'member_user')}) AS "is_eligible"
         FROM "users" "member_user"
         JOIN "profiles" "member_profile" ON "member_profile"."user_id" = "member_user"."id"
        WHERE "member_user"."id" = $1`,
      [userId],
    );
    return rows[0]?.is_eligible === true;
  }

  private async toRow(
    member: ListingTeamMember,
  ): Promise<ListingTeamMemberLinkRow> {
    const buildRows = await this.rowBuilder(this.dataSource.manager, [member]);
    const [row] = buildRows([member]);
    if (!row) {
      throw listingTeamError('listing_team_link_not_found');
    }
    return row;
  }

  /**
   * Loads every listing the rows point at in one query, their crops in one
   * batch and their public visibility in one query, then answers a mapper
   * that keeps each row's order. A row always carries its listing; a listing
   * hidden from the public comes back with `isListingLive: false`.
   */
  private async rowBuilder(
    manager: EntityManager,
    members: ListingTeamMember[],
  ): Promise<(rows: ListingTeamMember[]) => ListingTeamMemberLinkRow[]> {
    const listingIds = [...new Set(members.map((member) => member.listingId))];
    if (listingIds.length === 0) {
      return () => [];
    }
    const [listings, liveRows] = await Promise.all([
      manager.find(Listing, {
        select: LISTING_TEAM_LISTING_COLUMNS,
        where: { id: In(listingIds) },
      }),
      manager.query<{ id: string }[]>(
        `SELECT "listing"."id"
           FROM "listings" "listing"
          WHERE "listing"."id" = ANY($1::uuid[])
            AND ${publiclyVisibleListingSql('listing')}`,
        [listingIds],
      ),
    ]);
    const crops = await this.mediaCropService.getMany(
      listings.flatMap(listingCardPhotoKeys),
    );
    const listingById = new Map(
      listings.map((listing) => [listing.id, listing]),
    );
    const liveListingIds = new Set(liveRows.map((row) => row.id));
    return (rows) => {
      const shaped: ListingTeamMemberLinkRow[] = [];
      for (const member of rows) {
        const listing = listingById.get(member.listingId);
        if (!listing) continue;
        shaped.push(
          toListingTeamPersonaRow(
            member,
            toListingTeamListing(listing, crops),
            liveListingIds.has(member.listingId),
          ),
        );
      }
      return shaped;
    };
  }
}
