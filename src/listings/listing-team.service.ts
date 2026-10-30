import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, In } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberLookup } from '../common/member-ref';
import { MediaCropService } from '../media-crops/media-crops.service';
import {
  SubprofileLinkVisibility,
  type SubprofileKind,
} from '../subprofiles/entities/subprofile.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  ApproveListingTeamRequestDto,
  InviteListingTeamMemberByProfileDto,
  InviteListingTeamMemberDto,
  ReorderListingTeamDto,
  UpdateListingTeamMemberDto,
} from './dto/listing-team.dto';
import {
  LIVE_LISTING_TEAM_STATUSES,
  ListingTeamInitiator,
  ListingTeamMember,
  ListingTeamMemberStatus,
} from './entities/listing-team-member.entity';
import {
  memberAvatarKeys,
  ownerNameOf,
  personaAvatarKeys,
  teamStatusOf,
  toListingTeamManagerRow,
  toListingTeamMemberManagerRow,
  toListingTeamMemberProfile,
  toListingTeamPersona,
  type ListingTeamManagerList,
  type ListingTeamManagerRow,
  type ListingTeamMemberColumns,
  type ListingTeamMemberProfile,
  type ListingTeamPersona,
  type ListingTeamPersonaCandidate,
  type ListingTeamPersonaColumns,
} from './listing-team-response';
import {
  LISTING_TEAM_SEARCH,
  listingTeamError,
} from './listing-team.constants';
import {
  LISTING_TEAM_ACCEPTED,
  LISTING_TEAM_INVITED,
  LISTING_TEAM_MEMBER_INVITED,
  type ListingTeamAlertEvent,
  type ListingTeamMemberAlertEvent,
} from './listing-team.events';
import {
  eligibleMemberSql,
  eligiblePersonaSql,
  notBlockedEitherWaySql,
  notHiddenFromViewerSql,
} from './listing-team-visibility';
import {
  assertAcceptedRoom,
  assertInviteRoom,
  assertMemberAcceptedRoom,
  assertMemberPairOpen,
  assertPairOpen,
  hasBlockEitherWay,
  insertLiveMemberTeamRow,
  insertLiveTeamRow,
  isAcceptedConnection,
  isPersonaMember,
  lockListingRow,
  lockMemberCap,
  lockPersonaRow,
  lockTeamRow,
  nextTeamPosition,
  readListingFacts,
  readMemberFacts,
  readPersonaFacts,
} from './listing-team-write-rules';
import { ListingsService } from './listings.service';

/** The persona columns every team read selects, in snake case. The owner
 *  name parts come from `OWNER_PROFILE_JOIN_SQL` and are null for an unlinked
 *  persona. */
interface TeamPersonaRow {
  id: string;
  handle: string | null;
  display_name: string;
  kind: SubprofileKind;
  avatar_url: string | null;
  link_visibility: SubprofileLinkVisibility;
  owner_first_name: string | null;
  owner_last_name: string | null;
}

interface TeamCandidateRow extends TeamPersonaRow {
  team_status: ListingTeamMemberStatus | null;
}

/** The profile columns every member team read selects, in snake case, plus
 *  the user id that keys the result map and never leaves the server. */
interface TeamMemberProfileRow {
  user_id: string;
  slug: string;
  first_name: string;
  last_name: string;
  avatar_url: string | null;
  photo_visible: boolean;
}

/** The entity columns a manager row reads. `requestedByUserId` stays out.
 *  `userId` only tells a member row from a persona row and is never mapped to
 *  the wire. */
const MANAGER_ROW_COLUMNS = {
  id: true,
  listingId: true,
  subprofileId: true,
  userId: true,
  roleLabel: true,
  status: true,
  initiatedBy: true,
  answeredAt: true,
  position: true,
  createdAt: true,
} as const;

const LIVE_STATUS_LIST_SQL = LIVE_LISTING_TEAM_STATUSES.map(
  (status) => `'${status}'`,
).join(', ');

const PERSONA_COLUMNS_SQL = `"persona"."id", "persona"."handle", "persona"."display_name", "persona"."kind", "persona"."avatar_url", "persona"."link_visibility", "owner_profile"."first_name" AS "owner_first_name", "owner_profile"."last_name" AS "owner_last_name"`;

/** The owner's profile, joined for a linked persona alone, so an unlinked
 *  persona's owner name never leaves the database. The mapper gates on
 *  linked again. One row per persona: `profiles.user_id` is the key. */
const OWNER_PROFILE_JOIN_SQL = `LEFT JOIN "profiles" "owner_profile"
    ON "owner_profile"."user_id" = "persona"."user_id"
   AND "persona"."link_visibility" = '${SubprofileLinkVisibility.Linked}'`;

/** `$1` the persona ids, `$2` the caller. Keeps eligible personas whose owner
 *  has no block either way with the caller. */
const VISIBLE_TEAM_PERSONAS_SQL = `SELECT ${PERSONA_COLUMNS_SQL}
  FROM "subprofiles" "persona"
  ${OWNER_PROFILE_JOIN_SQL}
 WHERE "persona"."id" = ANY($1::uuid[])
   AND ${eligiblePersonaSql('persona')}
   AND ${notBlockedEitherWaySql('$2', '"persona"."user_id"')}`;

/** `$1` the member user ids, `$2` the caller. Keeps eligible members with no
 *  block either way with the caller who did not hide their profile from the
 *  caller. An ineligible, blocked, hidden or deactivated member is absent, so
 *  the row keeps standing with `member: null`. */
const VISIBLE_TEAM_MEMBERS_SQL = `SELECT "member_profile"."user_id", "member_profile"."slug", "member_profile"."first_name", "member_profile"."last_name", "member_profile"."avatar_url", "member_profile"."photo_visible"
  FROM "profiles" "member_profile"
  JOIN "users" "member_user" ON "member_user"."id" = "member_profile"."user_id"
 WHERE "member_profile"."user_id" = ANY($1::uuid[])
   AND ${eligibleMemberSql('member_profile', 'member_user')}
   AND ${notBlockedEitherWaySql('$2', '"member_profile"."user_id"')}
   AND ${notHiddenFromViewerSql('$2', '"member_profile"."user_id"')}`;

/** `$1` the listing, `$2` the escaped contains pattern for the name, `$3` the
 *  raw term for the exact handle match, `$4` the caller, `$5` the escaped
 *  prefix pattern for the handle, `$6` the listing's owner. Leaves out a
 *  persona whose owner has a block either way with the caller or with the
 *  listing's owner. A null owner matches no block row, so its term always
 *  holds. */
const PERSONA_CANDIDATES_SQL = `SELECT ${PERSONA_COLUMNS_SQL}, "member"."status" AS "team_status"
  FROM "subprofiles" "persona"
  ${OWNER_PROFILE_JOIN_SQL}
  LEFT JOIN "listing_team_members" "member"
    ON "member"."subprofile_id" = "persona"."id"
   AND "member"."listing_id" = $1
   AND "member"."status" IN (${LIVE_STATUS_LIST_SQL})
 WHERE ${eligiblePersonaSql('persona')}
   AND ("persona"."display_name" ILIKE $2 ESCAPE '\\' OR "persona"."handle" ILIKE $5 ESCAPE '\\')
   AND ${notBlockedEitherWaySql('$4', '"persona"."user_id"')}
   AND ${notBlockedEitherWaySql('$6', '"persona"."user_id"')}
 ORDER BY lower("persona"."handle") = lower($3) DESC, lower("persona"."display_name") ASC, "persona"."id" ASC
 LIMIT ${LISTING_TEAM_SEARCH.resultsMax}`;

/** `$1` the listing, `$2` the accepted ids in their new order. A row that
 *  ended between the accepted-id read and this write is skipped. */
const REORDER_TEAM_SQL = `UPDATE "listing_team_members" "member"
   SET "position" = "ordered"."ordinality", "updated_at" = now()
  FROM unnest($2::uuid[]) WITH ORDINALITY AS "ordered"("id", "ordinality")
 WHERE "member"."id" = "ordered"."id" AND "member"."listing_id" = $1
   AND "member"."status" = '${ListingTeamMemberStatus.Accepted}'`;

/** `$1` the listing. */
const ACCEPTED_TEAM_IDS_SQL = `SELECT "member"."id"
  FROM "listing_team_members" "member"
 WHERE "member"."listing_id" = $1
   AND "member"."status" = '${ListingTeamMemberStatus.Accepted}'`;

function compareIds(first: string, second: string): number {
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}

/** True for a row whose subject is a member rather than a persona. */
function isMemberRow(row: ListingTeamMember): boolean {
  return row.userId !== null && row.userId !== undefined;
}

/** Newest first, id as the tie break. */
function compareNewestFirst(
  first: ListingTeamMember,
  second: ListingTeamMember,
): number {
  const byCreatedAt = second.createdAt.getTime() - first.createdAt.getTime();
  return byCreatedAt !== 0 ? byCreatedAt : compareIds(second.id, first.id);
}

/** Team order: position ascending, id as the tie break. */
function compareTeamOrder(
  first: ListingTeamMember,
  second: ListingTeamMember,
): number {
  const byPosition = (first.position ?? 0) - (second.position ?? 0);
  return byPosition !== 0 ? byPosition : compareIds(first.id, second.id);
}

/**
 * The business side of "Meet the team": the listing's owner and active
 * co-managers invite personas and members, answer persona requests, label,
 * order and remove them. Every route passes `ListingsService.loadOwnedOrCoManagedOr404` first.
 *
 * Writes take their locks in the shared order (listing row, team row, then
 * the persona row or the member advisory lock) at the default READ COMMITTED isolation, so each cap count reads a
 * fresh snapshot after its lock. Events go out only after the commit.
 */
@Injectable()
export class ListingTeamService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly listingsService: ListingsService,
    private readonly mediaCropService: MediaCropService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async listForManager(
    ref: string,
    userId: string,
  ): Promise<ListingTeamManagerList> {
    const { listing } = await this.listingsService.loadOwnedOrCoManagedOr404(
      ref,
      userId,
    );
    const members = await this.dataSource.manager.find(ListingTeamMember, {
      select: MANAGER_ROW_COLUMNS,
      where: {
        listingId: listing.id,
        status: In([...LIVE_LISTING_TEAM_STATUSES]),
      },
    });
    const rows = await this.toManagerRows(members, userId);
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const rowsOf = (selected: ListingTeamMember[]): ListingTeamManagerRow[] =>
      selected.flatMap((member) => {
        const row = rowById.get(member.id);
        return row ? [row] : [];
      });

    const pending = members.filter(
      (member) => member.status === ListingTeamMemberStatus.Pending,
    );
    const requestsReceived = pending
      .filter((member) => member.initiatedBy === ListingTeamInitiator.Persona)
      .sort(compareNewestFirst);
    const invitesSent = pending
      .filter((member) => member.initiatedBy === ListingTeamInitiator.Listing)
      .sort(compareNewestFirst);
    const accepted = members
      .filter((member) => member.status === ListingTeamMemberStatus.Accepted)
      .sort(compareTeamOrder);

    return {
      awaitingYouCount: requestsReceived.length,
      requestsReceived: rowsOf(requestsReceived),
      invitesSent: rowsOf(invitesSent),
      accepted: rowsOf(accepted),
    };
  }

  async searchCandidates(
    ref: string,
    userId: string,
    query: string,
  ): Promise<{ items: ListingTeamPersonaCandidate[] }> {
    const { listing } = await this.listingsService.loadOwnedOrCoManagedOr404(
      ref,
      userId,
    );
    const escapedQuery = escapeLikeTerm(query);
    const rows = await this.dataSource.manager.query<TeamCandidateRow[]>(
      PERSONA_CANDIDATES_SQL,
      [
        listing.id,
        `%${escapedQuery}%`,
        query,
        userId,
        `${escapedQuery}%`,
        listing.ownerId,
      ],
    );
    const crops = await this.mediaCropService.getMany(
      personaAvatarKeys(rows.map(toPersonaColumns)),
    );
    const items: ListingTeamPersonaCandidate[] = [];
    for (const row of rows) {
      const persona = toListingTeamPersona(
        toPersonaColumns(row),
        crops,
        ownerNameOf(row.owner_first_name, row.owner_last_name),
      );
      if (persona) {
        items.push({ persona, teamStatus: teamStatusOf(row.team_status) });
      }
    }
    return { items };
  }

  async invite(
    ref: string,
    userId: string,
    body: InviteListingTeamMemberDto,
  ): Promise<ListingTeamManagerRow> {
    const { listing } = await this.listingsService.loadOwnedOrCoManagedOr404(
      ref,
      userId,
    );
    const { member, shouldNotify } = await this.dataSource.transaction(
      async (manager) => {
        await lockListingRow(manager, listing.id);
        const listingFacts = await readListingFacts(manager, listing.id);
        if (!listingFacts?.isPubliclyVisible) {
          throw listingTeamError('listing_team_listing_not_live');
        }
        if (!(await lockPersonaRow(manager, body.subprofileId))) {
          throw listingTeamError('listing_team_persona_not_found');
        }
        const personaFacts = await readPersonaFacts(manager, body.subprofileId);
        if (
          !personaFacts ||
          (await this.hasBlockAcrossTheLink(
            manager,
            userId,
            listingFacts.ownerUserId,
            personaFacts.ownerUserId,
          ))
        ) {
          throw listingTeamError('listing_team_persona_not_found');
        }
        if (!personaFacts.isEligible) {
          throw listingTeamError('listing_team_persona_ineligible');
        }
        await assertPairOpen(
          manager,
          listing.id,
          personaFacts.id,
          ListingTeamInitiator.Listing,
        );
        await assertAcceptedRoom(manager, listing.id, personaFacts.id);
        const roleLabel = body.roleLabel ?? null;

        if (await isPersonaMember(manager, personaFacts.id, userId)) {
          const linked = await insertLiveTeamRow(manager, {
            listingId: listing.id,
            subprofileId: personaFacts.id,
            initiatedBy: ListingTeamInitiator.Listing,
            requestedByUserId: userId,
            roleLabel,
            status: ListingTeamMemberStatus.Accepted,
            position: await nextTeamPosition(manager, listing.id),
            answeredAt: new Date(),
          });
          return { member: linked, shouldNotify: false };
        }

        await assertInviteRoom(manager, listing.id);
        const invited = await insertLiveTeamRow(manager, {
          listingId: listing.id,
          subprofileId: personaFacts.id,
          initiatedBy: ListingTeamInitiator.Listing,
          requestedByUserId: userId,
          roleLabel,
          status: ListingTeamMemberStatus.Pending,
          position: null,
          answeredAt: null,
        });
        return { member: invited, shouldNotify: true };
      },
    );

    if (shouldNotify) {
      this.emitAlert(LISTING_TEAM_INVITED, member.id, userId);
    }
    return this.toManagerRow(member, userId);
  }

  /**
   * Invites one of the acting manager's connections to the team. The member
   * is resolved by profile slug. Every refusal before the eligibility check
   * (unknown or deactivated slug, the acting manager themself, not an accepted
   * connection, a block either way with the acting manager or the listing
   * owner) answers the same
   * `listing_team_member_not_found`, so the response never says which one.
   */
  async inviteMember(
    ref: string,
    userId: string,
    body: InviteListingTeamMemberByProfileDto,
  ): Promise<ListingTeamManagerRow> {
    const { listing } = await this.listingsService.loadOwnedOrCoManagedOr404(
      ref,
      userId,
    );
    const member = await this.dataSource.transaction(async (manager) => {
      await lockListingRow(manager, listing.id);
      const listingFacts = await readListingFacts(manager, listing.id);
      if (!listingFacts?.isPubliclyVisible) {
        throw listingTeamError('listing_team_listing_not_live');
      }
      const memberUserId = await new MemberLookup(
        manager.getRepository(Profile),
      ).userIdForSlug(body.memberSlug);
      if (
        !memberUserId ||
        memberUserId === userId ||
        !(await isAcceptedConnection(manager, userId, memberUserId)) ||
        (await hasBlockEitherWay(manager, userId, memberUserId)) ||
        (listingFacts.ownerUserId !== userId &&
          (await hasBlockEitherWay(
            manager,
            memberUserId,
            listingFacts.ownerUserId,
          )))
      ) {
        throw listingTeamError('listing_team_member_not_found');
      }
      await lockMemberCap(manager, memberUserId);
      const memberFacts = await readMemberFacts(manager, memberUserId);
      if (!memberFacts) {
        throw listingTeamError('listing_team_member_not_found');
      }
      if (!memberFacts.isEligible) {
        throw listingTeamError('listing_team_member_ineligible');
      }
      await assertMemberPairOpen(manager, listing.id, memberFacts.userId);
      await assertInviteRoom(manager, listing.id);
      await assertMemberAcceptedRoom(manager, listing.id, memberFacts.userId);
      return insertLiveMemberTeamRow(manager, {
        listingId: listing.id,
        userId: memberFacts.userId,
        requestedByUserId: userId,
        roleLabel: body.roleLabel ?? null,
        status: ListingTeamMemberStatus.Pending,
        answeredAt: null,
      });
    });

    this.emitMemberAlert(LISTING_TEAM_MEMBER_INVITED, member.id, userId);
    return this.toManagerRow(member, userId);
  }

  async approve(
    ref: string,
    userId: string,
    memberId: string,
    body: ApproveListingTeamRequestDto,
  ): Promise<ListingTeamManagerRow> {
    const { listing } = await this.listingsService.loadOwnedOrCoManagedOr404(
      ref,
      userId,
    );
    const member = await this.dataSource.transaction(async (manager) => {
      await lockListingRow(manager, listing.id);
      const listingFacts = await readListingFacts(manager, listing.id);
      if (!listingFacts?.isPubliclyVisible) {
        throw listingTeamError('listing_team_listing_not_live');
      }
      const row = await this.lockRowOnListing(manager, memberId, listing.id);
      // A member row is always started by the listing, so only a persona
      // request can be approved.
      const requestingSubprofileId = row.subprofileId;
      if (
        row.initiatedBy !== ListingTeamInitiator.Persona ||
        requestingSubprofileId === null
      ) {
        throw listingTeamError('listing_team_link_not_found');
      }
      if (row.status !== ListingTeamMemberStatus.Pending) {
        throw listingTeamError('listing_team_not_pending');
      }
      if (!(await lockPersonaRow(manager, requestingSubprofileId))) {
        throw listingTeamError('listing_team_link_not_found');
      }
      const personaFacts = await readPersonaFacts(
        manager,
        requestingSubprofileId,
      );
      if (
        !personaFacts ||
        (await this.hasBlockAcrossTheLink(
          manager,
          userId,
          listingFacts.ownerUserId,
          personaFacts.ownerUserId,
        ))
      ) {
        throw listingTeamError('listing_team_link_not_found');
      }
      if (!personaFacts.isEligible) {
        throw listingTeamError('listing_team_persona_ineligible');
      }
      await assertAcceptedRoom(manager, listing.id, personaFacts.id);

      row.status = ListingTeamMemberStatus.Accepted;
      row.position = await nextTeamPosition(manager, listing.id);
      row.answeredAt = new Date();
      if (body.roleLabel !== undefined) {
        row.roleLabel = body.roleLabel;
      }
      await manager.update(
        ListingTeamMember,
        { id: row.id },
        {
          status: row.status,
          position: row.position,
          answeredAt: row.answeredAt,
          roleLabel: row.roleLabel,
        },
      );
      return row;
    });

    this.emitAlert(LISTING_TEAM_ACCEPTED, member.id, userId);
    return this.toManagerRow(member, userId);
  }

  async decline(ref: string, userId: string, memberId: string): Promise<void> {
    const { listing } = await this.listingsService.loadOwnedOrCoManagedOr404(
      ref,
      userId,
    );
    await this.dataSource.transaction(async (manager) => {
      const row = await this.lockRowOnListing(manager, memberId, listing.id);
      if (
        row.initiatedBy !== ListingTeamInitiator.Persona ||
        isMemberRow(row)
      ) {
        throw listingTeamError('listing_team_link_not_found');
      }
      if (row.status !== ListingTeamMemberStatus.Pending) {
        throw listingTeamError('listing_team_not_pending');
      }
      await manager.update(
        ListingTeamMember,
        { id: row.id },
        { status: ListingTeamMemberStatus.Declined, answeredAt: new Date() },
      );
    });
  }

  async cancel(ref: string, userId: string, memberId: string): Promise<void> {
    const { listing } = await this.listingsService.loadOwnedOrCoManagedOr404(
      ref,
      userId,
    );
    await this.dataSource.transaction(async (manager) => {
      const row = await this.lockRowOnListing(manager, memberId, listing.id);
      if (row.initiatedBy !== ListingTeamInitiator.Listing) {
        throw listingTeamError('listing_team_link_not_found');
      }
      if (row.status !== ListingTeamMemberStatus.Pending) {
        throw listingTeamError('listing_team_not_pending');
      }
      await manager.update(
        ListingTeamMember,
        { id: row.id },
        { status: ListingTeamMemberStatus.Cancelled },
      );
    });
  }

  async updateRoleLabel(
    ref: string,
    userId: string,
    memberId: string,
    body: UpdateListingTeamMemberDto,
  ): Promise<ListingTeamManagerRow> {
    const { listing } = await this.listingsService.loadOwnedOrCoManagedOr404(
      ref,
      userId,
    );
    const member = await this.dataSource.transaction(async (manager) => {
      const row = await this.lockRowOnListing(manager, memberId, listing.id);
      if (
        row.status !== ListingTeamMemberStatus.Pending &&
        row.status !== ListingTeamMemberStatus.Accepted
      ) {
        throw listingTeamError('listing_team_not_pending');
      }
      row.roleLabel = body.roleLabel;
      await manager.update(
        ListingTeamMember,
        { id: row.id },
        { roleLabel: row.roleLabel },
      );
      return row;
    });
    return this.toManagerRow(member, userId);
  }

  async reorder(
    ref: string,
    userId: string,
    body: ReorderListingTeamDto,
  ): Promise<{ accepted: ListingTeamManagerRow[] }> {
    const { listing } = await this.listingsService.loadOwnedOrCoManagedOr404(
      ref,
      userId,
    );
    await this.dataSource.transaction(async (manager) => {
      await lockListingRow(manager, listing.id);
      const acceptedRows = await manager.query<{ id: string }[]>(
        ACCEPTED_TEAM_IDS_SQL,
        [listing.id],
      );
      const acceptedIds = new Set(acceptedRows.map((row) => row.id));
      const requestedIds = new Set(body.memberIds);
      const isSameSet =
        requestedIds.size === body.memberIds.length &&
        requestedIds.size === acceptedIds.size &&
        body.memberIds.every((memberId) => acceptedIds.has(memberId));
      if (!isSameSet) {
        throw listingTeamError('listing_team_order_mismatch');
      }
      if (body.memberIds.length > 0) {
        await manager.query(REORDER_TEAM_SQL, [listing.id, body.memberIds]);
      }
    });

    const accepted = await this.dataSource.manager.find(ListingTeamMember, {
      select: MANAGER_ROW_COLUMNS,
      where: {
        listingId: listing.id,
        status: ListingTeamMemberStatus.Accepted,
      },
    });
    accepted.sort(compareTeamOrder);
    return { accepted: await this.toManagerRows(accepted, userId) };
  }

  async remove(ref: string, userId: string, memberId: string): Promise<void> {
    const { listing } = await this.listingsService.loadOwnedOrCoManagedOr404(
      ref,
      userId,
    );
    await this.dataSource.transaction(async (manager) => {
      const row = await this.lockRowOnListing(manager, memberId, listing.id);
      if (row.status !== ListingTeamMemberStatus.Accepted) {
        throw listingTeamError('listing_team_not_accepted');
      }
      await manager.update(
        ListingTeamMember,
        { id: row.id },
        { status: ListingTeamMemberStatus.Removed, position: null },
      );
    });
  }

  /**
   * True when the persona's owner has a block either way with the acting
   * manager or with the listing's owner. The owner pair is read only when the
   * listing's owner is someone other than the acting manager.
   */
  private async hasBlockAcrossTheLink(
    manager: EntityManager,
    actingUserId: string,
    listingOwnerUserId: string | null,
    personaOwnerUserId: string,
  ): Promise<boolean> {
    if (await hasBlockEitherWay(manager, actingUserId, personaOwnerUserId)) {
      return true;
    }
    if (listingOwnerUserId === actingUserId) {
      return false;
    }
    return hasBlockEitherWay(manager, personaOwnerUserId, listingOwnerUserId);
  }

  /** Locks the team row and answers it while it belongs to this listing. */
  private async lockRowOnListing(
    manager: EntityManager,
    memberId: string,
    listingId: string,
  ): Promise<ListingTeamMember> {
    const row = await lockTeamRow(manager, memberId);
    if (!row || row.listingId !== listingId) {
      throw listingTeamError('listing_team_link_not_found');
    }
    return row;
  }

  private emitAlert(
    eventName: string,
    memberId: string,
    actingUserId: string,
  ): void {
    const event: ListingTeamAlertEvent = { memberId, actingUserId };
    this.eventEmitter.emit(eventName, event);
  }

  private emitMemberAlert(
    eventName: string,
    memberId: string,
    actingUserId: string,
  ): void {
    const event: ListingTeamMemberAlertEvent = { memberId, actingUserId };
    this.eventEmitter.emit(eventName, event);
  }

  private async toManagerRow(
    member: ListingTeamMember,
    userId: string,
  ): Promise<ListingTeamManagerRow> {
    const [row] = await this.toManagerRows([member], userId);
    if (!row) {
      throw listingTeamError('listing_team_link_not_found');
    }
    return row;
  }

  /**
   * Answers rows in the order given. A persona row maps to null when the
   * persona is hidden or blocked; a member row maps to null when the member is
   * ineligible, blocked either way with the caller, or deactivated. Persona and
   * member subjects load through their own queries, each skipped when the page
   * holds none of that kind.
   */
  private async toManagerRows(
    members: ListingTeamMember[],
    userId: string,
  ): Promise<ListingTeamManagerRow[]> {
    if (members.length === 0) {
      return [];
    }
    const subprofileIds = new Set<string>();
    const memberUserIds = new Set<string>();
    for (const member of members) {
      if (isMemberRow(member)) {
        if (member.userId) memberUserIds.add(member.userId);
      } else if (member.subprofileId) {
        subprofileIds.add(member.subprofileId);
      }
    }
    const [personas, memberProfiles] = await Promise.all([
      subprofileIds.size > 0
        ? this.loadVisiblePersonas([...subprofileIds], userId)
        : new Map<string, ListingTeamPersona>(),
      memberUserIds.size > 0
        ? this.loadVisibleMembers([...memberUserIds], userId)
        : new Map<string, ListingTeamMemberProfile>(),
    ]);
    return members.map((member) =>
      isMemberRow(member)
        ? toListingTeamMemberManagerRow(
            member,
            (member.userId && memberProfiles.get(member.userId)) || null,
          )
        : toListingTeamManagerRow(
            member,
            (member.subprofileId && personas.get(member.subprofileId)) || null,
          ),
    );
  }

  /** The members the caller may see, keyed by user id, with one crop read. */
  private async loadVisibleMembers(
    memberUserIds: string[],
    userId: string,
  ): Promise<Map<string, ListingTeamMemberProfile>> {
    const rows = await this.dataSource.manager.query<TeamMemberProfileRow[]>(
      VISIBLE_TEAM_MEMBERS_SQL,
      [memberUserIds, userId],
    );
    const crops = await this.mediaCropService.getMany(
      memberAvatarKeys(rows.map(toMemberColumns)),
    );
    const memberProfiles = new Map<string, ListingTeamMemberProfile>();
    for (const row of rows) {
      memberProfiles.set(
        row.user_id,
        toListingTeamMemberProfile(toMemberColumns(row), crops),
      );
    }
    return memberProfiles;
  }

  /** The personas the caller may see, keyed by id, with one crop read. */
  private async loadVisiblePersonas(
    subprofileIds: string[],
    userId: string,
  ): Promise<Map<string, ListingTeamPersona>> {
    const rows = await this.dataSource.manager.query<TeamPersonaRow[]>(
      VISIBLE_TEAM_PERSONAS_SQL,
      [subprofileIds, userId],
    );
    const crops = await this.mediaCropService.getMany(
      personaAvatarKeys(rows.map(toPersonaColumns)),
    );
    const personas = new Map<string, ListingTeamPersona>();
    for (const row of rows) {
      const persona = toListingTeamPersona(
        toPersonaColumns(row),
        crops,
        ownerNameOf(row.owner_first_name, row.owner_last_name),
      );
      if (persona) personas.set(persona.id, persona);
    }
    return personas;
  }
}

function toPersonaColumns(row: TeamPersonaRow): ListingTeamPersonaColumns {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    kind: row.kind,
    avatarUrl: row.avatar_url,
    linkVisibility: row.link_visibility,
  };
}

function toMemberColumns(row: TeamMemberProfileRow): ListingTeamMemberColumns {
  return {
    slug: row.slug,
    firstName: row.first_name,
    lastName: row.last_name,
    avatarUrl: row.avatar_url,
    photoVisible: row.photo_visible,
  };
}
