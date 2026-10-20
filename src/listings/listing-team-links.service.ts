import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, In } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { MediaCropService } from '../media-crops/media-crops.service';
import { SubprofileMembershipService } from '../subprofiles/subprofile-membership.service';
import { RequestListingTeamLinkDto } from './dto/listing-team.dto';
import {
  LIVE_LISTING_TEAM_STATUSES,
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
  LISTING_TEAM_ACCEPTED,
  LISTING_TEAM_REQUESTED,
  type ListingTeamAlertEvent,
} from './listing-team.events';
import {
  LISTING_TEAM_LISTING_COLUMNS,
  teamStatusOf,
  toListingTeamListing,
  toListingTeamPersonaRow,
  type ListingTeamListingCandidate,
  type ListingTeamPersonaList,
  type ListingTeamPersonaRow,
} from './listing-team-response';
import {
  notBlockedEitherWaySql,
  publiclyVisibleListingSql,
} from './listing-team-visibility';
import {
  assertAcceptedRoom,
  assertPairOpen,
  assertRequestRoom,
  hasBlockEitherWay,
  insertLiveTeamRow,
  lockListingRow,
  lockPersonaRow,
  lockTeamRow,
  managesListing,
  nextTeamPosition,
  readListingFacts,
  readPersonaFacts,
  type TeamPersonaFacts,
} from './listing-team-write-rules';

/**
 * The team row columns the list reads select. The privacy guarantee comes
 * from the explicit mapper `toListingTeamPersonaRow`, which copies named
 * fields alone: request and accept load full rows through
 * `insertLiveTeamRow` and `lockTeamRow`, and `requestedByUserId` still never
 * reaches a shape built here.
 */
const TEAM_ROW_COLUMNS = {
  id: true,
  listingId: true,
  subprofileId: true,
  roleLabel: true,
  status: true,
  initiatedBy: true,
  answeredAt: true,
  position: true,
  createdAt: true,
  updatedAt: true,
} as const;

const LIVE_STATUS_LIST_SQL = LIVE_LISTING_TEAM_STATUSES.map(
  (status) => `'${status}'`,
).join(', ');

interface ListingCandidateRow {
  id: string;
  team_status: ListingTeamMemberStatus | null;
}

/** A team write's outcome: the row, plus the alert to send once it commits. */
interface CommittedTeamWrite {
  member: ListingTeamMember;
  alertEventName: string | null;
}

/**
 * The persona side of "Meet the team": the Works at pane of the persona
 * editor. Every route needs a seat on the persona (owner or co-owner); anyone
 * else, and an unknown persona, gets the same 404 so persona ids reveal
 * nothing.
 *
 * Writes take their locks in the shared order (listing row, team row,
 * persona row) at the default READ COMMITTED isolation, and alerts go out
 * only after the transaction commits.
 */
@Injectable()
export class ListingTeamLinksService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly membership: SubprofileMembershipService,
    private readonly mediaCropService: MediaCropService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async listForPersona(
    subprofileId: string,
    userId: string,
  ): Promise<ListingTeamPersonaList> {
    await this.assertSeat(subprofileId, userId);
    const manager = this.dataSource.manager;
    const invitesWhere = {
      subprofileId,
      status: ListingTeamMemberStatus.Pending,
      initiatedBy: ListingTeamInitiator.Listing,
    };
    const [invitesReceived, awaitingYouCount, requestsSent, accepted] =
      await Promise.all([
        manager.find(ListingTeamMember, {
          select: TEAM_ROW_COLUMNS,
          where: invitesWhere,
          order: { createdAt: 'DESC', id: 'DESC' },
          take: LISTING_TEAM_SEARCH.invitesReceivedMax,
        }),
        manager.count(ListingTeamMember, { where: invitesWhere }),
        manager.find(ListingTeamMember, {
          select: TEAM_ROW_COLUMNS,
          where: {
            subprofileId,
            status: ListingTeamMemberStatus.Pending,
            initiatedBy: ListingTeamInitiator.Persona,
          },
          order: { createdAt: 'DESC', id: 'DESC' },
        }),
        manager.find(ListingTeamMember, {
          select: TEAM_ROW_COLUMNS,
          where: { subprofileId, status: ListingTeamMemberStatus.Accepted },
          order: { answeredAt: 'ASC', id: 'ASC' },
        }),
      ]);
    const buildRows = await this.personaRowBuilder(manager, [
      ...invitesReceived,
      ...requestsSent,
      ...accepted,
    ]);
    return {
      awaitingYouCount,
      invitesReceived: buildRows(invitesReceived),
      requestsSent: buildRows(requestsSent),
      accepted: buildRows(accepted),
    };
  }

  async searchCandidates(
    subprofileId: string,
    userId: string,
    query: string,
  ): Promise<{ items: ListingTeamListingCandidate[] }> {
    await this.assertSeat(subprofileId, userId);
    const manager = this.dataSource.manager;
    const personaOwnerUserId = await this.readPersonaOwnerUserId(
      manager,
      subprofileId,
    );
    // `$3` the caller and `$4` the persona's owner: a listing whose owner has
    // a block either way with either of them stays out.
    const candidateRows = await manager.query<ListingCandidateRow[]>(
      `SELECT "listing"."id", "member"."status" AS "team_status"
         FROM "listings" "listing"
         LEFT JOIN "listing_team_members" "member"
           ON "member"."listing_id" = "listing"."id"
          AND "member"."subprofile_id" = $1
          AND "member"."status" IN (${LIVE_STATUS_LIST_SQL})
        WHERE "listing"."name" ILIKE $2 ESCAPE '\\'
          AND ${publiclyVisibleListingSql('listing')}
          AND "listing"."owner_id" IS NOT NULL
          AND ${notBlockedEitherWaySql('$3', '"listing"."owner_id"')}
          AND ${notBlockedEitherWaySql('$4', '"listing"."owner_id"')}
        ORDER BY lower("listing"."name") ASC, "listing"."id" ASC
        LIMIT ${LISTING_TEAM_SEARCH.resultsMax}`,
      [subprofileId, `%${escapeLikeTerm(query)}%`, userId, personaOwnerUserId],
    );
    if (candidateRows.length === 0) {
      return { items: [] };
    }
    const listings = await manager.find(Listing, {
      select: LISTING_TEAM_LISTING_COLUMNS,
      where: { id: In(candidateRows.map((row) => row.id)) },
    });
    const crops = await this.mediaCropService.getMany(
      listings.flatMap(listingCardPhotoKeys),
    );
    const listingById = new Map(
      listings.map((listing) => [listing.id, listing]),
    );
    const items: ListingTeamListingCandidate[] = [];
    for (const row of candidateRows) {
      const listing = listingById.get(row.id);
      if (!listing) continue;
      items.push({
        listing: toListingTeamListing(listing, crops),
        teamStatus: teamStatusOf(row.team_status),
      });
    }
    return { items };
  }

  async request(
    subprofileId: string,
    userId: string,
    body: RequestListingTeamLinkDto,
  ): Promise<ListingTeamPersonaRow> {
    await this.assertSeat(subprofileId, userId);
    const committed = await this.dataSource.transaction(
      async (manager): Promise<CommittedTeamWrite> => {
        await lockListingRow(manager, body.listingId);
        const listing = await readListingFacts(manager, body.listingId);
        if (
          !listing ||
          !listing.isPubliclyVisible ||
          listing.ownerUserId === null ||
          (await hasBlockEitherWay(manager, userId, listing.ownerUserId))
        ) {
          throw listingTeamError('listing_team_listing_not_found');
        }
        const persona = await this.lockAndReadPersona(manager, subprofileId);
        if (
          await this.hasOwnerPairBlock(
            manager,
            userId,
            listing.ownerUserId,
            persona.ownerUserId,
          )
        ) {
          throw listingTeamError('listing_team_listing_not_found');
        }
        this.assertPersonaEligible(persona);
        await assertPairOpen(
          manager,
          listing.id,
          subprofileId,
          ListingTeamInitiator.Persona,
        );
        await assertAcceptedRoom(manager, listing.id, subprofileId);
        if (await managesListing(manager, listing.id, userId)) {
          // A seat on both sides links at once, with no one to notify.
          const member = await insertLiveTeamRow(manager, {
            listingId: listing.id,
            subprofileId,
            initiatedBy: ListingTeamInitiator.Persona,
            requestedByUserId: userId,
            roleLabel: null,
            status: ListingTeamMemberStatus.Accepted,
            position: await nextTeamPosition(manager, listing.id),
            answeredAt: new Date(),
          });
          return { member, alertEventName: null };
        }
        await assertRequestRoom(manager, listing.id, subprofileId);
        const member = await insertLiveTeamRow(manager, {
          listingId: listing.id,
          subprofileId,
          initiatedBy: ListingTeamInitiator.Persona,
          requestedByUserId: userId,
          roleLabel: null,
          status: ListingTeamMemberStatus.Pending,
          position: null,
          answeredAt: null,
        });
        return { member, alertEventName: LISTING_TEAM_REQUESTED };
      },
    );
    this.emitAlert(committed, userId);
    return this.toPersonaRow(committed.member);
  }

  async accept(
    subprofileId: string,
    userId: string,
    linkId: string,
  ): Promise<ListingTeamPersonaRow> {
    await this.assertSeat(subprofileId, userId);
    const committed = await this.dataSource.transaction(
      async (manager): Promise<CommittedTeamWrite> => {
        // An unlocked read learns the row's listing, so the listing row can
        // be locked ahead of the team row.
        const located = await manager.findOne(ListingTeamMember, {
          select: { id: true, listingId: true, subprofileId: true },
          where: { id: linkId },
        });
        if (!located || located.subprofileId !== subprofileId) {
          throw listingTeamError('listing_team_link_not_found');
        }
        await lockListingRow(manager, located.listingId);
        const member = await lockTeamRow(manager, linkId);
        if (
          !member ||
          member.subprofileId !== subprofileId ||
          member.listingId !== located.listingId ||
          member.initiatedBy !== ListingTeamInitiator.Listing
        ) {
          throw listingTeamError('listing_team_link_not_found');
        }
        if (member.status !== ListingTeamMemberStatus.Pending) {
          throw listingTeamError('listing_team_not_pending');
        }
        const persona = await this.lockAndReadPersona(manager, subprofileId);
        const listing = await readListingFacts(manager, member.listingId);
        if (
          !listing ||
          (await hasBlockEitherWay(manager, userId, listing.ownerUserId)) ||
          (await this.hasOwnerPairBlock(
            manager,
            userId,
            listing.ownerUserId,
            persona.ownerUserId,
          ))
        ) {
          throw listingTeamError('listing_team_link_not_found');
        }
        if (!listing.isPubliclyVisible) {
          throw listingTeamError('listing_team_listing_not_live');
        }
        this.assertPersonaEligible(persona);
        await assertAcceptedRoom(manager, member.listingId, subprofileId);
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
        return { member, alertEventName: LISTING_TEAM_ACCEPTED };
      },
    );
    this.emitAlert(committed, userId);
    return this.toPersonaRow(committed.member);
  }

  /** Says no to a listing's invite. Quiet; starts that listing's cooldown. */
  async decline(
    subprofileId: string,
    userId: string,
    linkId: string,
  ): Promise<void> {
    await this.assertSeat(subprofileId, userId);
    await this.dataSource.transaction(async (manager) => {
      await this.lockPendingRowOfDirection(
        manager,
        subprofileId,
        linkId,
        ListingTeamInitiator.Listing,
      );
      await manager.update(
        ListingTeamMember,
        { id: linkId },
        { status: ListingTeamMemberStatus.Declined, answeredAt: new Date() },
      );
    });
  }

  /** Takes back the persona's own request before an answer. Quiet. */
  async cancel(
    subprofileId: string,
    userId: string,
    linkId: string,
  ): Promise<void> {
    await this.assertSeat(subprofileId, userId);
    await this.dataSource.transaction(async (manager) => {
      await this.lockPendingRowOfDirection(
        manager,
        subprofileId,
        linkId,
        ListingTeamInitiator.Persona,
      );
      await manager.update(
        ListingTeamMember,
        { id: linkId },
        { status: ListingTeamMemberStatus.Cancelled },
      );
    });
  }

  /** Steps the persona off an accepted team. Quiet. */
  async leave(
    subprofileId: string,
    userId: string,
    linkId: string,
  ): Promise<void> {
    await this.assertSeat(subprofileId, userId);
    await this.dataSource.transaction(async (manager) => {
      const member = await lockTeamRow(manager, linkId);
      if (!member || member.subprofileId !== subprofileId) {
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

  /** Owner or co-owner of the persona; an unknown persona answers the same 404. */
  private async assertSeat(
    subprofileId: string,
    userId: string,
  ): Promise<void> {
    if (!(await this.membership.isMember(userId, subprofileId))) {
      throw listingTeamError('listing_team_persona_not_found');
    }
  }

  /** The persona's owner, or persona not found when the row is gone. */
  private async readPersonaOwnerUserId(
    manager: EntityManager,
    subprofileId: string,
  ): Promise<string> {
    const rows = await manager.query<{ user_id: string }[]>(
      `SELECT "persona"."user_id" FROM "subprofiles" "persona" WHERE "persona"."id" = $1`,
      [subprofileId],
    );
    const ownerUserId = rows[0]?.user_id;
    if (ownerUserId === undefined) {
      throw listingTeamError('listing_team_persona_not_found');
    }
    return ownerUserId;
  }

  /**
   * Locks the persona row, then reads its facts under that lock. A persona
   * gone since the seat check answers persona not found.
   */
  private async lockAndReadPersona(
    manager: EntityManager,
    subprofileId: string,
  ): Promise<TeamPersonaFacts> {
    if (!(await lockPersonaRow(manager, subprofileId))) {
      throw listingTeamError('listing_team_persona_not_found');
    }
    const persona = await readPersonaFacts(manager, subprofileId);
    if (!persona) {
      throw listingTeamError('listing_team_persona_not_found');
    }
    return persona;
  }

  private assertPersonaEligible(persona: TeamPersonaFacts): void {
    if (!persona.isEligible) {
      throw listingTeamError('listing_team_persona_ineligible');
    }
  }

  /**
   * True when the persona's owner and the listing's owner have a block either
   * way. The pair is read only when the persona's owner is someone other than
   * the acting member, whose own block the caller has already checked.
   */
  private async hasOwnerPairBlock(
    manager: EntityManager,
    actingUserId: string,
    listingOwnerUserId: string | null,
    personaOwnerUserId: string,
  ): Promise<boolean> {
    if (personaOwnerUserId === actingUserId) {
      return false;
    }
    return hasBlockEitherWay(manager, personaOwnerUserId, listingOwnerUserId);
  }

  /**
   * Locks a pending row of this persona started by `initiatedBy`. A row of
   * another persona or of the other direction answers link not found; an
   * answered or ended row answers not pending.
   */
  private async lockPendingRowOfDirection(
    manager: EntityManager,
    subprofileId: string,
    linkId: string,
    initiatedBy: ListingTeamInitiator,
  ): Promise<void> {
    const member = await lockTeamRow(manager, linkId);
    if (
      !member ||
      member.subprofileId !== subprofileId ||
      member.initiatedBy !== initiatedBy
    ) {
      throw listingTeamError('listing_team_link_not_found');
    }
    if (member.status !== ListingTeamMemberStatus.Pending) {
      throw listingTeamError('listing_team_not_pending');
    }
  }

  private emitAlert(committed: CommittedTeamWrite, userId: string): void {
    if (committed.alertEventName === null) return;
    const event: ListingTeamAlertEvent = {
      memberId: committed.member.id,
      actingUserId: userId,
    };
    this.eventEmitter.emit(committed.alertEventName, event);
  }

  private async toPersonaRow(
    member: ListingTeamMember,
  ): Promise<ListingTeamPersonaRow> {
    const buildRows = await this.personaRowBuilder(this.dataSource.manager, [
      member,
    ]);
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
  private async personaRowBuilder(
    manager: EntityManager,
    members: ListingTeamMember[],
  ): Promise<(rows: ListingTeamMember[]) => ListingTeamPersonaRow[]> {
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
      const shaped: ListingTeamPersonaRow[] = [];
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
