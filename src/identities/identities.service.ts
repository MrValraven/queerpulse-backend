import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryFailedError, Repository } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { toVisibleAvatarUrl } from '../common/member-ref';
import { Company } from '../companies/entities/company.entity';
import { CompanyTeamMember } from '../companies/entities/company-team-member.entity';
import {
  ListingCoManager,
  ListingCoManagerStatus,
} from '../listings/entities/listing-co-manager.entity';
import { Listing } from '../listings/entities/listing.entity';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { countUnreadConversationsByIdentity } from '../messaging/unread-conversations-query';
import { Profile } from '../users/entities/profile.entity';
import { MailboxSummaryDto, toMailboxSummary } from './dto/mailbox-summary.dto';
import { IdentityStaffPreference } from './entities/identity-staff-preference.entity';
import {
  Identity,
  IdentityKind,
  IdentityOwnerColumn,
  ownerColumnForKind,
} from './entities/identity.entity';

/**
 * The identity's own name, handle and avatar, resolved from whichever entity
 * actually owns those fields for its kind (`Profile`/`Listing`/`Subprofile`/
 * `Company`). See `IdentitiesService.describeIdentities` for how each kind's
 * fields were chosen.
 */
export interface IdentityDescription {
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
}

/**
 * The one filter that makes a listing co-manager staff of the listing's
 * mailbox. Both directions of the staffing question read it: "who staffs
 * this listing" (`staffUserIds`) and "which listings does this member
 * staff" (`listMailboxesFor`), so the switcher never offers a mailbox the
 * send path would refuse, and never leaves out one it would accept. Persona
 * co-owners and company team members carry no status and need no filter.
 */
const ACTIVE_LISTING_CO_MANAGER = {
  status: ListingCoManagerStatus.Active,
} as const;

/** Task 15: one mailbox a member staffs, before its identity row is read. */
interface StaffedMailbox {
  kind: IdentityKind;
  ownerEntityId: string;
  isOwner: boolean;
}

/** Task 15: the switcher's order after the profile mailbox, which leads. */
const MAILBOX_KIND_ORDER: ReadonlyArray<IdentityKind> = [
  IdentityKind.Profile,
  IdentityKind.Listing,
  IdentityKind.Subprofile,
  IdentityKind.Company,
];

/**
 * Owns two questions and nothing else: which humans may act for an identity,
 * and which identity a given thing is. Every authorization decision about
 * acting as a business goes through here, so the rules live in one file.
 */
@Injectable()
export class IdentitiesService {
  constructor(
    @InjectRepository(Identity)
    private readonly identities: Repository<Identity>,
    @InjectRepository(Listing)
    private readonly listings: Repository<Listing>,
    @InjectRepository(ListingCoManager)
    private readonly listingCoManagers: Repository<ListingCoManager>,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(SubprofileMember)
    private readonly subprofileMembers: Repository<SubprofileMember>,
    @InjectRepository(Company)
    private readonly companies: Repository<Company>,
    @InjectRepository(CompanyTeamMember)
    private readonly companyTeamMembers: Repository<CompanyTeamMember>,
    // Only `describeIdentities` reads this: a `Profile`-kind identity's
    // display fields live on the member's own profile row, the same row
    // every other messaging read path already resolves a profile author
    // summary from.
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    // Only `listMailboxesFor` reads this, for the member's own seats in each
    // mailbox (`countUnreadConversationsByIdentity`).
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    // Task 20: only `listMailboxesFor` reads this, for the caller's own
    // `shouldAllowMyName` on every mailbox it lists, in one query.
    @InjectRepository(IdentityStaffPreference)
    private readonly preferences: Repository<IdentityStaffPreference>,
  ) {}

  async getById(identityId: string): Promise<Identity | null> {
    return this.identities.findOne({ where: { id: identityId } });
  }

  /**
   * Batched `getById`: every identity in `identityIds` in ONE query, for a
   * caller rendering a page of conversations that must not turn "which
   * identity is this" into a per-row lookup. A thread carries at most a
   * handful of distinct identities, but a full inbox page carries one for
   * every row, so a per-row `getById` would grow with page size the same way
   * the per-message attribution lookup this pairs with used to. Order is not
   * guaranteed to match `identityIds`; a caller that needs a specific
   * identity keys the result by `id` itself.
   */
  async getByIds(identityIds: string[]): Promise<Identity[]> {
    const uniqueIdentityIds = [...new Set(identityIds)];
    if (uniqueIdentityIds.length === 0) {
      return [];
    }
    return this.identities.find({ where: { id: In(uniqueIdentityIds) } });
  }

  /**
   * The identity's own display name, handle and avatar, batched by kind: one
   * query to learn each identity's kind and owner row, then at most one
   * further query per kind actually present in `identityIds` (never one per
   * identity), the same fixed-cost shape `buildStaffNameResolver` uses for
   * staff attribution. A thread's or page's mix of senders is at most the
   * four kinds `IdentityKind` has, so this never grows with message or page
   * count.
   *
   * Column choices, one per kind:
   * - `Profile`: `firstName`/`lastName` joined for `displayName`, `slug` for
   *   `handle`, and `avatarUrl` through `toVisibleAvatarUrl` so a member who
   *   hid their photo stays hidden here too, mirroring `authorSummaryFrom`
   *   exactly (the same fields the existing profile-author path already
   *   uses).
   * - `Listing`: `name` for `displayName`, `slug` for `handle`, and the
   *   COVER photo, `photoGallery[0].image` resolved through `toImageUrl`,
   *   for `avatarUrl`. The legacy `photos`/`alt` columns are explicitly
   *   documented on the entity as not the source of truth for "what photos
   *   does this listing have"; `photoGallery` is.
   * - `Subprofile`: `displayName` for `displayName`, `handle` for `handle`
   *   (nullable: a linked, unpublished persona may carry no global handle,
   *   only the nested `slug`, which is not independently routable without
   *   its owner's own username, so `handle` stays null, leaving the caller
   *   to fall back on its own generic label), `avatarUrl`
   *   resolved through `toImageUrl`.
   * - `Company`: `nameText` for `displayName`, `slug` for `handle`.
   *   `avatarUrl` is always null: `Company` carries no avatar or logo
   *   column today (only `slug`, `nameText` and `tagline`), so this null is
   *   the complete, correct answer for a `Company` for as long as that
   *   stays true.
   *
   * An identity absent from `identities` entirely, or one whose owner row
   * (the listing/subprofile/company/profile it points at) has since
   * vanished, is simply absent from the returned map. Every caller must
   * treat a missing entry as "show the mailbox with no display data
   * available" and assume nothing about which ids it asked for come back.
   */
  async describeIdentities(
    identityIds: string[],
  ): Promise<Map<string, IdentityDescription>> {
    const uniqueIdentityIds = [...new Set(identityIds)];
    const result = new Map<string, IdentityDescription>();
    if (uniqueIdentityIds.length === 0) {
      return result;
    }
    const identities = await this.identities.find({
      where: { id: In(uniqueIdentityIds) },
    });

    const profileIdentities = identities.filter(
      (identity): identity is Identity & { userId: string } =>
        identity.kind === IdentityKind.Profile && identity.userId !== null,
    );
    const listingIdentities = identities.filter(
      (identity): identity is Identity & { listingId: string } =>
        identity.kind === IdentityKind.Listing && identity.listingId !== null,
    );
    const subprofileIdentities = identities.filter(
      (identity): identity is Identity & { subprofileId: string } =>
        identity.kind === IdentityKind.Subprofile &&
        identity.subprofileId !== null,
    );
    const companyIdentities = identities.filter(
      (identity): identity is Identity & { companyId: string } =>
        identity.kind === IdentityKind.Company && identity.companyId !== null,
    );

    const [profileRows, listingRows, subprofileRows, companyRows] =
      await Promise.all([
        profileIdentities.length
          ? this.profiles.find({
              where: {
                userId: In(
                  profileIdentities.map((identity) => identity.userId),
                ),
              },
            })
          : Promise.resolve([]),
        listingIdentities.length
          ? this.listings.find({
              where: {
                id: In(listingIdentities.map((identity) => identity.listingId)),
              },
            })
          : Promise.resolve([]),
        subprofileIdentities.length
          ? this.subprofiles.find({
              where: {
                id: In(
                  subprofileIdentities.map((identity) => identity.subprofileId),
                ),
              },
            })
          : Promise.resolve([]),
        companyIdentities.length
          ? this.companies.find({
              where: {
                id: In(companyIdentities.map((identity) => identity.companyId)),
              },
            })
          : Promise.resolve([]),
      ]);

    const profileByUserId = new Map(profileRows.map((p) => [p.userId, p]));
    for (const identity of profileIdentities) {
      const profile = profileByUserId.get(identity.userId);
      if (!profile) {
        continue;
      }
      result.set(identity.id, {
        displayName: `${profile.firstName} ${profile.lastName}`.trim(),
        handle: profile.slug,
        avatarUrl: toVisibleAvatarUrl(profile),
      });
    }

    const listingById = new Map(listingRows.map((l) => [l.id, l]));
    for (const identity of listingIdentities) {
      const listing = listingById.get(identity.listingId);
      if (!listing) {
        continue;
      }
      result.set(identity.id, {
        displayName: listing.name,
        handle: listing.slug,
        avatarUrl: toImageUrl(listing.photoGallery[0]?.image ?? null),
      });
    }

    const subprofileById = new Map(subprofileRows.map((s) => [s.id, s]));
    for (const identity of subprofileIdentities) {
      const subprofile = subprofileById.get(identity.subprofileId);
      if (!subprofile) {
        continue;
      }
      result.set(identity.id, {
        displayName: subprofile.displayName,
        handle: subprofile.handle,
        avatarUrl: toImageUrl(subprofile.avatarUrl),
      });
    }

    const companyById = new Map(companyRows.map((c) => [c.id, c]));
    for (const identity of companyIdentities) {
      const company = companyById.get(identity.companyId);
      if (!company) {
        continue;
      }
      result.set(identity.id, {
        displayName: company.nameText,
        handle: company.slug,
        // Permanent: `Company` has no avatar/logo column. See this method's
        // own doc for the full explanation.
        avatarUrl: null,
      });
    }

    return result;
  }

  async resolveProfileIdentityId(userId: string): Promise<string> {
    const identity = await this.ensureIdentityFor(IdentityKind.Profile, userId);
    return identity.id;
  }

  /**
   * Get or create. Creation exists for things made before this table and for
   * the race where two requests touch a brand new listing at once, which the
   * partial unique index settles.
   */
  async ensureIdentityFor(
    kind: IdentityKind,
    ownerId: string,
  ): Promise<Identity> {
    const ownerColumn = ownerColumnForKind(kind);
    const existing = await this.identities.findOne({
      where: { [ownerColumn]: ownerId },
    });
    if (existing) {
      return existing;
    }
    try {
      return await this.identities.save(
        this.identities.create({
          kind,
          [ownerColumn]: ownerId,
        } as Partial<Identity>),
      );
    } catch (err) {
      // Lost a concurrent create race on the partial unique index, so return
      // the winner. Anything else (a bad ownerId tripping a foreign key, a
      // dropped connection) is a real failure that must not be reinterpreted
      // as a race, so its original error and stack survive.
      if (
        err instanceof QueryFailedError &&
        (err.driverError as { code?: string })?.code === '23505'
      ) {
        const winner = await this.identities.findOne({
          where: { [ownerColumn]: ownerId },
        });
        if (winner) {
          return winner;
        }
        throw new Error(
          `Race recovery failed: no identity found for ${kind} ${ownerId} after a unique violation`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  /**
   * Every human who may read and answer this mailbox, owner first. The owner
   * leads the list because callers that need a single responsible person, such
   * as a read-only fallback, take the head.
   */
  async staffUserIds(identityId: string): Promise<string[]> {
    const identity = await this.getById(identityId);
    if (!identity) {
      return [];
    }
    switch (identity.kind) {
      case IdentityKind.Profile:
        return identity.userId ? [identity.userId] : [];
      case IdentityKind.Listing:
        return this.listingStaff(identity.listingId);
      case IdentityKind.Subprofile:
        return this.subprofileStaff(identity.subprofileId);
      case IdentityKind.Company:
        return this.companyStaff(identity.companyId);
    }
  }

  /** True when this human may read and send in that identity's mailbox. */
  async isAllowedToActAs(userId: string, identityId: string): Promise<boolean> {
    const staff = await this.staffUserIds(identityId);
    return staff.includes(userId);
  }

  /**
   * Task 20: which human owns `identity`'s mailbox, one column per kind:
   * `listings.owner_id`, `subprofiles.user_id`, `companies.owner_id`. A
   * listing co-manager, a persona co-owner and a company team member are
   * staff and never the owner, matching `MailboxSummaryDto.isOwner`'s own
   * doc. An ownerless listing (its owner column erased, co-managers remain)
   * has no owner, so this reads null until the listing gains one again; the
   * owner's mailbox switch stays locked for that whole gap
   * (`IdentityAttributionSettingsService.updateOwnerSwitch`), a deliberate
   * product choice: the toggle stays the owner's own call alone. A
   * `Profile` identity carries no separate owner concept for this question:
   * it reads null, since the profile mailbox switch has no meaning either.
   */
  async ownerUserIdOf(identity: Identity): Promise<string | null> {
    switch (identity.kind) {
      case IdentityKind.Profile:
        return null;
      case IdentityKind.Listing: {
        if (!identity.listingId) {
          return null;
        }
        const listing = await this.listings.findOne({
          where: { id: identity.listingId },
          select: { ownerId: true },
        });
        return listing?.ownerId ?? null;
      }
      case IdentityKind.Subprofile: {
        if (!identity.subprofileId) {
          return null;
        }
        const subprofile = await this.subprofiles.findOne({
          where: { id: identity.subprofileId },
          select: { userId: true },
        });
        return subprofile?.userId ?? null;
      }
      case IdentityKind.Company: {
        if (!identity.companyId) {
          return null;
        }
        const company = await this.companies.findOne({
          where: { id: identity.companyId },
          select: { ownerId: true },
        });
        return company?.ownerId ?? null;
      }
    }
  }

  /**
   * The single authorization gate for acting as an identity. Every messaging
   * write path calls this, including edit, delete, attachments, forwarding and
   * reactions, so the guarantee holds at each door.
   *
   * CW-28 ruling (cleanup wave): a moderation-removed persona may still
   * DELETE its own past messages, since removing content is safety-positive
   * and every OTHER write stays refused. `isDeletingOwnMessage` is the one
   * exception this gate carries: the caller passes it true only from the
   * delete-own-message path, after it has already confirmed the human is
   * that message's own author, and the `IDENTITY_REMOVED` refusal below is
   * skipped for that call alone. The staff-membership check above still
   * runs unconditionally either way: a removed persona keeps its staff and
   * their seats (`staffUserIds` is unchanged), so this exception never widens
   * who may act, only what a removed persona's own already-allowed staff may
   * still do once removed.
   */
  async assertMayActAs(
    userId: string,
    identityId: string,
    options: { isDeletingOwnMessage?: boolean } = {},
  ): Promise<void> {
    if (!(await this.isAllowedToActAs(userId, identityId))) {
      throw new ForbiddenException({
        code: 'IDENTITY_NOT_STAFF',
        message: 'You cannot send as this identity',
      });
    }
    if (options.isDeletingOwnMessage) {
      return;
    }
    // Task 15 fix round 1: a persona that moderation removed keeps its staff
    // and their seats, so they can still read its threads (`staffUserIds` is
    // unchanged), and it speaks no more: every write refuses here. The
    // mailbox switcher shows the same persona as read-only
    // (`MailboxSummaryDto.isReadOnly`), from the same read.
    const identity = await this.getById(identityId);
    if (
      identity?.kind === IdentityKind.Subprofile &&
      identity.subprofileId &&
      (await this.removedSubprofileIds([identity.subprofileId])).size > 0
    ) {
      throw new ForbiddenException({
        code: 'IDENTITY_REMOVED',
        message: 'This persona was removed and cannot send messages',
      });
    }
  }

  /**
   * Task 18: whether `identity` is a persona that moderation removed
   * (`subprofiles.removed_at` set), read through the same query
   * `assertMayActAs` refuses on. Such a persona speaks no more, and it is not
   * contactable either: a customer cannot open a new thread with it.
   */
  async isRemovedPersona(identity: Identity): Promise<boolean> {
    if (identity.kind !== IdentityKind.Subprofile || !identity.subprofileId) {
      return false;
    }
    const removedSubprofileIds = await this.removedSubprofileIds([
      identity.subprofileId,
    ]);
    return removedSubprofileIds.size > 0;
  }

  /**
   * Task 15 fix round 1: which of `subprofileIds` moderation removed
   * (`subprofiles.removed_at` set), in one query. The single answer to "may
   * this persona still speak", read by `assertMayActAs` and by
   * `listMailboxesFor` for `isReadOnly`.
   */
  private async removedSubprofileIds(
    subprofileIds: ReadonlyArray<string>,
  ): Promise<Set<string>> {
    const uniqueSubprofileIds = [...new Set(subprofileIds)];
    if (uniqueSubprofileIds.length === 0) {
      return new Set();
    }
    const subprofiles = await this.subprofiles.find({
      where: { id: In(uniqueSubprofileIds) },
      select: { id: true, removedAt: true },
    });
    return new Set(
      subprofiles
        .filter((subprofile) => subprofile.removedAt != null)
        .map((subprofile) => subprofile.id),
    );
  }

  /**
   * Task 15: every mailbox `userId` may read and answer, for the header
   * mailbox switcher. The member's own profile mailbox leads, then every
   * listing, persona and company mailbox, each group ordered by name.
   *
   * "Staff of" is exactly what `staffUserIds` accepts, read in the other
   * direction: a listing the member owns or co-manages with an active
   * co-manager row, a persona they own or co-own, a company they own or are
   * a team member of. Each identity is described once by
   * `describeIdentities`, and every unread count comes from ONE grouped
   * query (`countUnreadConversationsByIdentity`) under the nav badge's own
   * definition, so a mailbox never counts a thread its member cannot open.
   *
   * Every mailbox is addressed by `identityId`, so this ensures each one has
   * its `identities` row: a business made before that table, which nothing
   * has touched since, gets its row here, in one batched insert (see
   * `ensureMailboxIdentities`).
   */
  async listMailboxesFor(userId: string): Promise<MailboxSummaryDto[]> {
    const staffedMailboxes = await this.staffedMailboxesFor(userId);
    const identityByMailbox =
      await this.ensureMailboxIdentities(staffedMailboxes);
    const resolvedMailboxes = staffedMailboxes.flatMap((mailbox) => {
      const identity = identityByMailbox.get(mailboxKey(mailbox));
      return identity
        ? [{ ...mailbox, identityId: identity.id, identity }]
        : [];
    });
    const identityIds = resolvedMailboxes.map((mailbox) => mailbox.identityId);
    const [
      descriptionById,
      unreadCountById,
      removedSubprofileIds,
      ownPreferenceRows,
    ] = await Promise.all([
      this.describeIdentities(identityIds),
      countUnreadConversationsByIdentity(
        this.participants,
        userId,
        identityIds,
      ),
      this.removedSubprofileIds(
        resolvedMailboxes
          .filter((mailbox) => mailbox.kind === IdentityKind.Subprofile)
          .map((mailbox) => mailbox.ownerEntityId),
      ),
      // Task 20: ONE query for the caller's own preference rows across every
      // listed mailbox, never one per mailbox.
      identityIds.length
        ? this.preferences.find({
            where: { identityId: In(identityIds), userId },
          })
        : Promise.resolve([]),
    ]);
    const shouldAllowMyNameByIdentityId = new Map(
      ownPreferenceRows.map((row) => [row.identityId, row.shouldAllowNaming]),
    );
    const summaries = resolvedMailboxes.map((mailbox) => {
      const isProfile = mailbox.kind === IdentityKind.Profile;
      return toMailboxSummary({
        identityId: mailbox.identityId,
        kind: mailbox.kind,
        description: descriptionById.get(mailbox.identityId),
        unreadCount: unreadCountById.get(mailbox.identityId) ?? 0,
        isOwner: mailbox.isOwner,
        isReadOnly:
          mailbox.kind === IdentityKind.Subprofile &&
          removedSubprofileIds.has(mailbox.ownerEntityId),
        // The profile mailbox carries null for both: naming has no meaning
        // for a member acting as themself.
        shouldShowStaffNames: isProfile
          ? null
          : mailbox.identity.shouldShowStaffNames,
        shouldAllowMyName: isProfile
          ? null
          : (shouldAllowMyNameByIdentityId.get(mailbox.identityId) ?? true),
      });
    });
    // The identity id breaks a tie between equal names, so the switcher keeps
    // one order across requests.
    return summaries.sort(
      (first, second) =>
        MAILBOX_KIND_ORDER.indexOf(first.kind) -
          MAILBOX_KIND_ORDER.indexOf(second.kind) ||
        (first.displayName ?? '').localeCompare(second.displayName ?? '') ||
        first.identityId.localeCompare(second.identityId),
    );
  }

  /**
   * Task 15: the reverse of `listingStaff`/`subprofileStaff`/`companyStaff`,
   * reading the same owner columns and the same member tables with the same
   * filters, in six queries whatever the member staffs. A member who both
   * owns and co-manages one listing appears once, as its owner.
   */
  private async staffedMailboxesFor(userId: string): Promise<StaffedMailbox[]> {
    const [
      ownedListings,
      listingCoManagerRows,
      ownedSubprofiles,
      subprofileMemberRows,
      ownedCompanies,
      companyTeamMemberRows,
    ] = await Promise.all([
      this.listings.find({ where: { ownerId: userId }, select: { id: true } }),
      this.listingCoManagers.find({
        where: { userId, ...ACTIVE_LISTING_CO_MANAGER },
      }),
      this.subprofiles.find({ where: { userId }, select: { id: true } }),
      this.subprofileMembers.find({ where: { userId } }),
      this.companies.find({ where: { ownerId: userId }, select: { id: true } }),
      this.companyTeamMembers.find({ where: { userId } }),
    ]);
    const staffedMailboxes = new Map<string, StaffedMailbox>();
    const addMailbox = (mailbox: StaffedMailbox) => {
      const key = mailboxKey(mailbox);
      const existing = staffedMailboxes.get(key);
      staffedMailboxes.set(key, {
        ...mailbox,
        isOwner: mailbox.isOwner || Boolean(existing?.isOwner),
      });
    };
    addMailbox({
      kind: IdentityKind.Profile,
      ownerEntityId: userId,
      isOwner: true,
    });
    for (const listing of ownedListings) {
      addMailbox({
        kind: IdentityKind.Listing,
        ownerEntityId: listing.id,
        isOwner: true,
      });
    }
    for (const coManager of listingCoManagerRows) {
      addMailbox({
        kind: IdentityKind.Listing,
        ownerEntityId: coManager.listingId,
        isOwner: false,
      });
    }
    for (const subprofile of ownedSubprofiles) {
      addMailbox({
        kind: IdentityKind.Subprofile,
        ownerEntityId: subprofile.id,
        isOwner: true,
      });
    }
    for (const member of subprofileMemberRows) {
      addMailbox({
        kind: IdentityKind.Subprofile,
        ownerEntityId: member.subprofileId,
        isOwner: false,
      });
    }
    for (const company of ownedCompanies) {
      addMailbox({
        kind: IdentityKind.Company,
        ownerEntityId: company.id,
        isOwner: true,
      });
    }
    for (const teamMember of companyTeamMemberRows) {
      addMailbox({
        kind: IdentityKind.Company,
        ownerEntityId: teamMember.companyId,
        isOwner: false,
      });
    }
    return [...staffedMailboxes.values()];
  }

  /**
   * Task 15: the `identities` row of every mailbox, keyed by `mailboxKey`,
   * creating the missing ones the way `ensureIdentityFor` does, batched: one
   * read of every existing row, and only when some are missing, one insert
   * of all of them and one read back. `ON CONFLICT DO NOTHING` settles a
   * race with a concurrent `ensureIdentityFor` on the partial unique index,
   * and the read back returns whichever row won.
   *
   * Fix round 1: the rows go in sorted by `mailboxKey`, so every concurrent
   * writer takes the index entries in one global order and two members
   * staffing each other's businesses cannot deadlock. A foreign key
   * violation (23503) means an owner was hard-deleted after the staffing
   * read; those mailboxes are dropped (`withoutVanishedOwners`) and the
   * insert runs once more for the rest. Every other failure still throws.
   */
  private async ensureMailboxIdentities(
    mailboxes: ReadonlyArray<StaffedMailbox>,
  ): Promise<Map<string, Identity>> {
    const identityByMailbox = await this.findMailboxIdentities(mailboxes);
    let missingMailboxes = mailboxes
      .filter((mailbox) => !identityByMailbox.has(mailboxKey(mailbox)))
      .sort((first, second) =>
        mailboxKey(first).localeCompare(mailboxKey(second)),
      );
    if (missingMailboxes.length === 0) {
      return identityByMailbox;
    }
    try {
      await this.insertMailboxIdentities(missingMailboxes);
    } catch (error) {
      if (!isForeignKeyViolation(error)) {
        throw error;
      }
      missingMailboxes = await this.withoutVanishedOwners(missingMailboxes);
      if (missingMailboxes.length > 0) {
        await this.insertMailboxIdentities(missingMailboxes);
      }
    }
    const createdIdentities =
      await this.findMailboxIdentities(missingMailboxes);
    for (const [key, identity] of createdIdentities) {
      identityByMailbox.set(key, identity);
    }
    return identityByMailbox;
  }

  /** Task 15: one `INSERT ... ON CONFLICT DO NOTHING` of every row in
   *  `mailboxes`, in the order given. */
  private async insertMailboxIdentities(
    mailboxes: ReadonlyArray<StaffedMailbox>,
  ): Promise<void> {
    await this.identities
      .createQueryBuilder()
      .insert()
      .into(Identity)
      .values(
        mailboxes.map((mailbox) => ({
          kind: mailbox.kind,
          [ownerColumnForKind(mailbox.kind)]: mailbox.ownerEntityId,
        })),
      )
      .orIgnore()
      .execute();
  }

  /**
   * Fix round 1: `mailboxes` minus those whose listing, persona or company
   * row no longer exists, read with at most one query per kind. A profile
   * mailbox is always the caller's own, whose user row exists for as long
   * as they are signed in, so it is kept.
   */
  private async withoutVanishedOwners(
    mailboxes: ReadonlyArray<StaffedMailbox>,
  ): Promise<StaffedMailbox[]> {
    const ownerEntityIdsOf = (kind: IdentityKind) =>
      mailboxes
        .filter((mailbox) => mailbox.kind === kind)
        .map((mailbox) => mailbox.ownerEntityId);
    const listingIds = ownerEntityIdsOf(IdentityKind.Listing);
    const subprofileIds = ownerEntityIdsOf(IdentityKind.Subprofile);
    const companyIds = ownerEntityIdsOf(IdentityKind.Company);
    const [listingRows, subprofileRows, companyRows] = await Promise.all([
      listingIds.length
        ? this.listings.find({
            where: { id: In(listingIds) },
            select: { id: true },
          })
        : Promise.resolve([]),
      subprofileIds.length
        ? this.subprofiles.find({
            where: { id: In(subprofileIds) },
            select: { id: true },
          })
        : Promise.resolve([]),
      companyIds.length
        ? this.companies.find({
            where: { id: In(companyIds) },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);
    const existingOwnerKeys = new Set([
      ...listingRows.map((listing) =>
        mailboxKey({ kind: IdentityKind.Listing, ownerEntityId: listing.id }),
      ),
      ...subprofileRows.map((subprofile) =>
        mailboxKey({
          kind: IdentityKind.Subprofile,
          ownerEntityId: subprofile.id,
        }),
      ),
      ...companyRows.map((company) =>
        mailboxKey({ kind: IdentityKind.Company, ownerEntityId: company.id }),
      ),
    ]);
    return mailboxes.filter(
      (mailbox) =>
        mailbox.kind === IdentityKind.Profile ||
        existingOwnerKeys.has(mailboxKey(mailbox)),
    );
  }

  /** Task 15: the existing `identities` rows of `mailboxes`, in one query,
   *  looked up by owner column exactly as `ensureIdentityFor` looks one up. */
  private async findMailboxIdentities(
    mailboxes: ReadonlyArray<StaffedMailbox>,
  ): Promise<Map<string, Identity>> {
    const ownerEntityIdsByColumn = new Map<IdentityOwnerColumn, string[]>();
    for (const mailbox of mailboxes) {
      const ownerColumn = ownerColumnForKind(mailbox.kind);
      ownerEntityIdsByColumn.set(ownerColumn, [
        ...(ownerEntityIdsByColumn.get(ownerColumn) ?? []),
        mailbox.ownerEntityId,
      ]);
    }
    const identityByMailbox = new Map<string, Identity>();
    if (ownerEntityIdsByColumn.size === 0) {
      return identityByMailbox;
    }
    const identities = await this.identities.find({
      where: [...ownerEntityIdsByColumn].map(
        ([ownerColumn, ownerEntityIds]) => ({
          [ownerColumn]: In(ownerEntityIds),
        }),
      ),
    });
    for (const identity of identities) {
      const ownerEntityId = identity[ownerColumnForKind(identity.kind)];
      if (ownerEntityId) {
        identityByMailbox.set(
          mailboxKey({ kind: identity.kind, ownerEntityId }),
          identity,
        );
      }
    }
    return identityByMailbox;
  }

  private async listingStaff(listingId: string | null): Promise<string[]> {
    if (!listingId) {
      return [];
    }
    const listing = await this.listings.findOne({ where: { id: listingId } });
    const coManagers = await this.listingCoManagers.find({
      where: { listingId, ...ACTIVE_LISTING_CO_MANAGER },
    });
    return dedupe([
      ...(listing?.ownerId ? [listing.ownerId] : []),
      ...coManagers.map((coManager) => coManager.userId),
    ]);
  }

  private async subprofileStaff(
    subprofileId: string | null,
  ): Promise<string[]> {
    if (!subprofileId) {
      return [];
    }
    const subprofile = await this.subprofiles.findOne({
      where: { id: subprofileId },
    });
    const members = await this.subprofileMembers.find({
      where: { subprofileId },
    });
    return dedupe([
      ...(subprofile?.userId ? [subprofile.userId] : []),
      ...members.map((member) => member.userId),
    ]);
  }

  private async companyStaff(companyId: string | null): Promise<string[]> {
    if (!companyId) {
      return [];
    }
    const company = await this.companies.findOne({ where: { id: companyId } });
    const teamMembers = await this.companyTeamMembers.find({
      where: { companyId },
    });
    return dedupe([
      ...(company?.ownerId ? [company.ownerId] : []),
      ...teamMembers.map((teamMember) => teamMember.userId),
    ]);
  }
}

/** Fix round 1: a Postgres foreign key violation (SQLSTATE 23503). */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string })?.code === '23503'
  );
}

/** Task 15: one mailbox's key, its kind and the entity that owns it. */
function mailboxKey(
  mailbox: Pick<StaffedMailbox, 'kind' | 'ownerEntityId'>,
): string {
  return `${mailbox.kind}:${mailbox.ownerEntityId}`;
}

function dedupe(userIds: string[]): string[] {
  return [...new Set(userIds)];
}
