import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository, SelectQueryBuilder } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { normalizeHandle } from '../common/handles';
import { toImageUrl } from '../common/image-url';
import { toVisibleAvatarUrl } from '../common/member-ref';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { Handle, HandleOwnerKind } from '../handles/entities/handle.entity';
import { HandlesService } from '../handles/handles.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { foldedHaystack, foldedSearchTerm } from '../search/search-text';
import { BlockFilterService } from '../social/block-filter.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import {
  DIRECTORY_DEFAULT_LIMIT,
  DIRECTORY_MAX_LIMIT,
  ListSubprofileDirectoryQuery,
} from './dto/list-directory.query';
import { SubprofileAffiliation } from './entities/subprofile-affiliation.entity';
import {
  Subprofile,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import {
  SubprofileItem,
  SubprofileSection,
} from './entities/subprofile-item.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { SubprofileSocialLink } from './entities/subprofile-social-link.entity';
import { SubprofileEndorsementsService } from './subprofile-endorsements.service';
import { SubprofileFollowersService } from './subprofile-followers.service';
import { SubprofileMembershipService } from './subprofile-membership.service';
import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from './subprofile-takedown';
import {
  AffiliationView,
  CollaboratorView,
  imageKeysFor,
  restrictedAccessBody,
  SubprofileCardView,
  SubprofileOwnerRef,
  SubprofilePublicView,
  SubprofileSearchRow,
  toCardDTO,
  toPublicDTO,
  toSubprofileSearchRow,
} from './subprofile-response';

// A visitor with no session has no block/endorsement/follow/membership rows.
// This fixed, never-issued uuid stands in for "no viewer" in the batched
// per-viewer lookups below (`isMember`, `blockFilter.*`, `viewerEndorsedFor`,
// `viewerFollowingFor`) — all of which take a plain `viewerId: string` and
// treat a missing/undefined id as "match nothing" would be wrong for (TypeORM
// silently drops an `undefined` where-clause value rather than matching
// nothing). It never collides with a real `users.id` (a v4 uuid), so every
// one of those lookups correctly comes back empty/false for an anonymous
// visitor (Personas redesign Phase 1b: the public persona read now allows
// anonymous callers so a signed-out visitor can get a `members_only` signal
// instead of a blanket 401).
const ANONYMOUS_VIEWER_ID = '00000000-0000-0000-0000-000000000000';

// The owner half of the directory's free-text search: one accent-folded blob
// over the linked owner's name and profile handle, joined as `owner` in
// `directory()`. Built with `foldedHaystack` so the folding here is character
// for character the folding member search already uses — a second spelling of
// "fold a name" is how two search boxes on one platform quietly disagree about
// whether "Joao" finds "João". Columns are the DB's snake_case names, which is
// what `qualifyColumn` quotes. Only the NAME columns: an owner's bio is not
// something a persona should be findable by.
const OWNER_SEARCH_HAYSTACK = foldedHaystack('owner', [
  'first_name',
  'last_name',
  'slug',
]);

// The public/card read surface for personas: the profile-nested list, the
// by-handle + by-slug single fetches, the directory browse, cross-entity
// search, and the sitemap handle enumeration — plus every batched resolver
// they (and the owner-facing reads on `SubprofilesService`) share. Extracted
// from the former god-service; owns only reads, so it depends downward on the
// membership gate and never back on the write/orchestration facade.
@Injectable()
export class SubprofilePublicReadService {
  constructor(
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(SubprofileItem)
    private readonly items: Repository<SubprofileItem>,
    @InjectRepository(SubprofileSocialLink)
    private readonly socialLinks: Repository<SubprofileSocialLink>,
    @InjectRepository(SubprofileAffiliation)
    private readonly affiliations: Repository<SubprofileAffiliation>,
    @InjectRepository(SubprofileMember)
    private readonly members: Repository<SubprofileMember>,
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(Handle)
    private readonly handleRegistry: Repository<Handle>,
    private readonly blockFilter: BlockFilterService,
    // Read-only, and only for the two `previous*OwnerOf` reclaim lookups
    // (PRD-204). Every WRITE against the namespace stays on `SubprofilesService`
    // where it can share the publish/unpublish transaction.
    private readonly handles: HandlesService,
    private readonly contentModeration: ContentModerationService,
    private readonly endorsementsService: SubprofileEndorsementsService,
    private readonly followersService: SubprofileFollowersService,
    private readonly membership: SubprofileMembershipService,
    // Batched crop lookup for `avatarUrl`/`coverUrl`/item `imageUrl` — see
    // `MediaCropService.getMany` and `../media-crops/crop-response.ts`.
    private readonly mediaCropService: MediaCropService,
  ) {}

  // A persona is reported (and taken down) under the `subprofile` subject code,
  // keyed by its slug. A hidden OR removed persona vanishes from every public
  // read (profile-nested, by-handle, directory, search, sitemap) for everyone —
  // a public surface with no per-viewer staff role, so (like the directory) a
  // takedown withholds it entirely. Owner-facing reads (`listMine`/`getOwned`)
  // don't re-check this state, so the owner still sees + manages their persona.
  // One spelling, shared with the follow/endorse write gates. See
  // `subprofile-takedown.ts`.
  private static readonly SUBJECT_TYPE = SUBPROFILE_MODERATION_SUBJECT_TYPE;

  // NOT EXISTS predicate dropping any persona under a `subprofile` takedown
  // (hidden OR removed) from a persona query builder (alias `sp`), in-query so
  // the capped result stays consistent. Mirrors
  // `DirectoryService.excludeModeratedListings`. `content_moderation.subject_id`
  // is varchar and `sp.slug` is varchar, so no cast is needed.
  private excludeModeratedSubprofiles(
    qb: SelectQueryBuilder<Subprofile>,
  ): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cm"
        WHERE "cm"."subject_type" = :subprofileSubjectType
          AND "cm"."subject_id" = sp.slug
          AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
      )`,
      { subprofileSubjectType: SubprofilePublicReadService.SUBJECT_TYPE },
    );
  }

  // Post-fetch variant for the `find`-based public reads (`listForProfile`,
  // `listPublicHandles`) that hold rows rather than a query builder. Returns
  // the subset whose slug carries no takedown.
  private async dropModeratedSubprofiles<Row extends { slug: string }>(
    rows: Row[],
  ): Promise<Row[]> {
    if (!rows.length) return rows;
    const states = await this.contentModeration.statesFor(
      SubprofilePublicReadService.SUBJECT_TYPE,
      rows.map((row) => row.slug),
    );
    return rows.filter((row) => {
      const state = states.get(row.slug);
      return !state || (!state.hidden && !state.removed);
    });
  }

  // Linked + published personas nested under a member's main profile.
  async listForProfile(
    ownerSlug: string,
    viewerId: string,
  ): Promise<SubprofilePublicView[]> {
    const profile = await this.profiles.findOne({
      where: { slug: ownerSlug },
    });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    // A block either way severs the nested-persona listing.
    if (await this.blockFilter.isBlockedEitherWay(viewerId, profile.userId)) {
      return [];
    }
    // Co-owner-aware: any persona where this profile's user is a member
    // (creator or co-owner) shows nested under their profile, not only ones
    // they created (`sp.userId`).
    const memberRows = await this.members.find({
      where: { userId: profile.userId },
      select: { subprofileId: true },
    });
    const memberIds = memberRows.map((row) => row.subprofileId);
    const linkedSps = memberIds.length
      ? await this.subprofiles.find({
          where: {
            id: In(memberIds),
            linkVisibility: SubprofileLinkVisibility.Linked,
            status: SubprofileStatus.Published,
            // A removed persona is withheld from this bulk read too (only
            // owner-facing reads like `listMine`/`getOwned` skip this — see
            // `buildPublicView`'s single-item "removed" gate for the signal a
            // direct fetch returns instead).
            removedAt: IsNull(),
          },
          order: { position: 'ASC', createdAt: 'ASC' },
        })
      : [];
    // Drop any persona under a moderator takedown before it renders nested on
    // the profile.
    const visibleSps = await this.dropModeratedSubprofiles(linkedSps);
    // A block by the persona's CREATOR severs it here too, and the check above
    // only covers the profile being viewed. A co-owned persona lists on every
    // co-owner's profile, so a creator who blocked this viewer still reached
    // them through somebody else's page: the card carries that creator's name
    // and slug (`ownerRefFor` below), and its link resolves against the
    // creator alone, which `getBySlugForProfile` then refuses on this same
    // block. Listing it advertised a member who had set a boundary and led
    // nowhere.
    //
    // Only the creator is consulted, deliberately. A persona is partly the
    // work of each owner, but the creator is the one this DTO names and
    // addresses, while the other co-owners' identities never reach it. Hiding
    // on ANY owner's block would let a single co-owner erase a shared persona
    // from the creator's own profile for that viewer, which is a wider power
    // than a block is meant to carry.
    //
    // Blocks are symmetric, so one batched `blockedUserIds` over the page's
    // creators covers both directions, and it drops the viewer's own id.
    const blockedCreatorIds = await this.blockFilter.blockedUserIds(
      viewerId,
      visibleSps.map((sp) => sp.userId),
    );
    const sps = visibleSps.filter((sp) => !blockedCreatorIds.has(sp.userId));
    const subprofileIds = sps.map((sp) => sp.id);
    // Every read below is mutually independent (each is its own batched query
    // keyed on the same `subprofileIds`) — fire them in one round trip instead
    // of eight sequential awaits. "Is the viewer a co-owner of THIS persona?"
    // is one batched lookup too (avoids an N+1 members fetch per card).
    const [
      itemsById,
      socialLinksById,
      endorsementCountsById,
      viewerEndorsedIds,
      followerCountsById,
      viewerFollowingIds,
      affiliationsById,
      viewerMemberRows,
    ] = await Promise.all([
      this.loadItemsFor(subprofileIds),
      this.loadSocialLinksFor(subprofileIds),
      this.endorsementsService.loadEndorsementCountsFor(subprofileIds),
      this.endorsementsService.viewerEndorsedFor(viewerId, subprofileIds),
      this.followersService.loadFollowerCountsFor(subprofileIds),
      this.followersService.viewerFollowingFor(viewerId, subprofileIds),
      this.resolveAffiliationsFor(viewerId, subprofileIds),
      subprofileIds.length
        ? this.members.find({
            where: { subprofileId: In(subprofileIds), userId: viewerId },
            select: { subprofileId: true },
          })
        : Promise.resolve([]),
    ]);
    // Resolve ALL personas' item collaborator handles in ONE batched call,
    // shared by every mapper invocation below (no per-persona resolution).
    // Depends on `itemsById`, so it follows the batch above.
    const collaboratorsByHandle = await this.resolveCollaboratorsFor(
      viewerId,
      [...itemsById.values()].flat(),
    );
    // ONE batched crop lookup for every persona's avatar/cover + every item
    // image in the whole list — never a per-persona/per-item query.
    const crops = await this.mediaCropService.getMany(
      sps.flatMap((sp) => imageKeysFor(sp, itemsById.get(sp.id) ?? [])),
    );
    const viewerMemberIds = new Set(
      viewerMemberRows.map((row) => row.subprofileId),
    );
    // The owner ref is the persona's CREATOR (`sp.userId`), even though this
    // list is keyed on a profile that may only CO-own it. `ownerSlug` is what
    // the frontend builds `/members/:ownerSlug/:slug` from, and the nested
    // route (`getBySlugForProfile`) resolves that pair against the creator's
    // `userId` alone. Handing back the viewed profile's slug for a co-owned
    // persona produced a link that 404s, and, when that co-owner happened to
    // have a persona of their own under the same per-owner slug, a link that
    // opened the OTHER persona: a wrong-person disclosure. One canonical URL
    // per persona, under its creator, is also what the owner dashboard already
    // builds (`personaPublicPathForOwner` + `usePersonaCreatorSlug`) and what
    // `directory()` emits, so this brings the three into agreement.
    //
    // Resolved in ONE batched lookup over the page's distinct creator ids.
    // Usually there are none to fetch: every persona this member created is
    // already covered by `profile`, so the query only fires for genuinely
    // co-owned rows.
    const creatorProfileByUserId = new Map<string, Profile>([
      [profile.userId, profile],
    ]);
    const coOwnedCreatorIds = [
      ...new Set(
        sps
          .map((sp) => sp.userId)
          .filter((userId) => userId !== profile.userId),
      ),
    ];
    if (coOwnedCreatorIds.length) {
      const creatorProfiles = await this.profiles.find({
        where: { userId: In(coOwnedCreatorIds) },
      });
      for (const creatorProfile of creatorProfiles) {
        creatorProfileByUserId.set(creatorProfile.userId, creatorProfile);
      }
    }
    // `undefined` when a creator somehow has no profile row. `toPublicDTO`
    // then omits `ownerSlug`/`ownerName` entirely rather than emitting a slug
    // that routes to the wrong persona.
    const ownerRefFor = (
      creatorUserId: string,
    ): SubprofileOwnerRef | undefined => {
      const creatorProfile = creatorProfileByUserId.get(creatorUserId);
      if (!creatorProfile) return undefined;
      return {
        slug: creatorProfile.slug,
        name: `${creatorProfile.firstName} ${creatorProfile.lastName}`.trim(),
      };
    };
    return sps.map((sp) =>
      toPublicDTO(
        sp,
        itemsById.get(sp.id) ?? [],
        ownerRefFor(sp.userId),
        socialLinksById.get(sp.id) ?? [],
        endorsementCountsById.get(sp.id) ?? 0,
        viewerEndorsedIds.has(sp.id),
        followerCountsById.get(sp.id) ?? 0,
        viewerFollowingIds.has(sp.id),
        affiliationsById.get(sp.id) ?? [],
        collaboratorsByHandle,
        viewerMemberIds.has(sp.id),
        crops,
      ),
    );
  }

  // Unlinked persona reachable by its global handle (owner-stripped, unless
  // the viewer IS the owner/a co-owner). `viewer` is `undefined` for an
  // anonymous caller — the by-handle route now allows signed-out visitors so
  // an anonymous visitor on a `network` persona gets `members_only` rather
  // than a blanket 401 (design plan Phase 1b Task 1). Status/visibility are no
  // longer pre-filtered in the query — `buildPublicView` below decides,
  // per the Shared Contract rule order, whether this viewer may see it at all.
  async getByHandle(
    handle: string,
    viewer: CurrentUserData | undefined,
  ): Promise<SubprofilePublicView> {
    const sp = await this.subprofiles.findOne({
      where: {
        handle,
        linkVisibility: SubprofileLinkVisibility.Unlinked,
      },
    });
    if (!sp) {
      // PRD-204: no live persona holds this handle, but the persona that used
      // to may still be inside its reclaim cooldown. Always throws.
      return this.throwPersonaMovedOrNotFound(handle, viewer);
    }
    // no owner ref → owner identity never leaks for an unlinked persona.
    return this.buildPublicView(sp, viewer, undefined);
  }

  /**
   * PRD-204 for `/p/<handle>`. A persona handle is the address printed on a
   * card, pasted into a bio and scanned off a QR code, and until now renaming
   * one killed every copy of it at once. The reclaim ledger already knows which
   * persona held the name, so a rename can forward instead of breaking.
   *
   * The forwarding is bounded by the same window that protects the name:
   * `previousSubprofileOwnerOf` answers only while the reclaim cooldown is
   * running and nothing holds the name in the live registry. Once either fails,
   * this stops answering, so a stranger who legitimately claims the handle can
   * never inherit traffic and trust meant for the persona that had it. That is
   * also why the answer is computed per request rather than stored: the route's
   * `AnonymousPublicCacheInterceptor` downgrades a moved answer to `no-store`
   * so no shared cache can hold one past the boundary.
   *
   * ---------------------------------------------------------------------------
   * WHY THE FULL VISIBILITY GATE RUNS AGAIN, ON THE PERSONA IT RESOLVED
   * ---------------------------------------------------------------------------
   * This route answers anonymous callers, so "that handle moved to @new" is a
   * disclosure in its own right: it says a persona still exists and names where
   * it lives. A persona that was renamed AND unpublished, made private or
   * network-only, removed, or taken down has said no, and must stay
   * indistinguishable from a handle nobody ever held. So the resolved persona
   * goes through `assertPublicViewVisible` — the very decision `buildPublicView`
   * makes for a first-hand visit — and every one of its refusals, the 403s
   * included, is flattened into the plain 404. A 403 here would itself be the
   * oracle: it would confirm the persona exists and say why it is withheld,
   * which is more than the new address would tell this viewer.
   *
   * Never returns. The caller treats it as a throw.
   */
  private async throwPersonaMovedOrNotFound(
    handle: string,
    viewer: CurrentUserData | undefined,
  ): Promise<never> {
    const previousOwnerSubprofileId =
      await this.handles.previousSubprofileOwnerOf(handle);
    if (!previousOwnerSubprofileId) {
      throw new NotFoundException('Subprofile not found');
    }
    const moved = await this.subprofiles.findOne({
      where: { id: previousOwnerSubprofileId },
    });
    // A persona with no current handle has not moved anywhere: it released the
    // name by unpublishing or by going linked, and there is no new address to
    // send anyone to. Same plain 404.
    if (
      !moved ||
      !moved.handle ||
      moved.linkVisibility !== SubprofileLinkVisibility.Unlinked
    ) {
      throw new NotFoundException('Subprofile not found');
    }
    await this.assertMovedTargetVisibleOrNotFound(
      moved,
      viewer,
      'Subprofile not found',
    );
    // An application-level payload rather than an HTTP 301/308, matching
    // `ProfilesService.throwMovedOrNotFound` so the SPA branch stays one shape.
    // A 301/308 is permanently cacheable and this forwarding MUST expire with
    // the reclaim cooldown; and `fetch` follows a redirect transparently, so
    // the app would render the persona under the dead URL and never correct the
    // address bar.
    throw new NotFoundException({
      code: 'PERSONA_MOVED',
      message: 'That handle has moved',
      handle: moved.handle,
    });
  }

  /**
   * Run `buildPublicView`'s own "may this viewer see it at all?" decision on a
   * persona we are about to NAME rather than render, and collapse every refusal
   * it can make into the plain 404.
   *
   * `assertPublicViewVisible` throws a 403 carrying `restrictedState` for
   * private/members-only/removed, which is the right answer at an address the
   * viewer asked for directly. At a MOVED address it would be an existence
   * oracle, so the 403s and the 404s alike become the single plain 404. Any
   * other failure (a database fault, say) is re-thrown untouched: a broken read
   * must never be reported as an absence.
   */
  private async assertMovedTargetVisibleOrNotFound(
    sp: Subprofile,
    viewer: CurrentUserData | undefined,
    // The message every refusal collapses onto. It is a parameter because each
    // caller has to be indistinguishable from ITS OWN first miss, and the two
    // misses read differently: an unknown handle answers `Subprofile not
    // found`, an unknown owner slug answers `Profile not found`. Hard-coding
    // one would let a client tell "moved, but withheld from you" apart from
    // "never existed" by the message alone, which is the oracle this whole
    // method exists to close.
    notFoundMessage: string,
  ): Promise<void> {
    const isOwner = viewer
      ? await this.membership.isMember(viewer.userId, sp.id)
      : false;
    try {
      await this.assertPublicViewVisible(sp, viewer, isOwner);
    } catch (err) {
      if (
        err instanceof ForbiddenException ||
        err instanceof NotFoundException
      ) {
        throw new NotFoundException(notFoundMessage);
      }
      throw err;
    }
  }

  // Single linked + published persona nested under a member's profile, by its
  // per-owner slug — the nested-linked counterpart to `getByHandle`. A single
  // fetch (rather than the bulk `listForProfile` list) is what lets this one
  // persona carry its own distinguishable restricted-state signal. Same
  // owner-sees-everything + Shared Contract rule order as `getByHandle`.
  async getBySlugForProfile(
    ownerSlug: string,
    subslug: string,
    viewer: CurrentUserData | undefined,
  ): Promise<SubprofilePublicView> {
    const profile = await this.profiles.findOne({
      where: { slug: ownerSlug },
    });
    if (!profile) {
      // PRD-204, the second door onto the same defect: the persona handle here
      // is a per-OWNER slug, so a nested persona dies when its owner renames
      // even though the persona was never re-addressed. Always throws.
      return this.throwOwnerMovedOrNotFound(ownerSlug, subslug, viewer);
    }
    const sp = await this.subprofiles.findOne({
      where: {
        slug: subslug,
        userId: profile.userId,
        linkVisibility: SubprofileLinkVisibility.Linked,
      },
    });
    if (!sp) {
      throw new NotFoundException('Subprofile not found');
    }
    const owner: SubprofileOwnerRef = {
      slug: profile.slug,
      name: `${profile.firstName} ${profile.lastName}`.trim(),
    };
    return this.buildPublicView(sp, viewer, owner);
  }

  /**
   * PRD-204 for `/members/<ownerSlug>/<subslug>`. The persona's own address
   * never changed here: its OWNER renamed, and the lookup above resolves the
   * owner by the live `profiles.slug` alone, so every shared nested-persona
   * link died on a username change the persona had no part in. A member cannot
   * tell that apart from the handle case, so it forwards the same way.
   *
   * The owner side of the answer comes from `previousProfileOwnerOf` verbatim,
   * so the cooldown and live-registry conditions are the ones the username
   * routes already enforce rather than a second spelling of them.
   *
   * What gates the disclosure is the PERSONA, and deliberately so. This route
   * answers anonymous callers, and naming a member's new username is a
   * disclosure about a member. It is emitted only when the persona at
   * `/members/<newSlug>/<subslug>` is one this very viewer could already open
   * first-hand, which makes the payload tell them nothing that address would
   * not. A persona that is unpublished, private, network-only, removed or taken
   * down gets the plain 404, and with it the owner's new username stays unsaid.
   *
   * Never returns. The caller treats it as a throw.
   */
  private async throwOwnerMovedOrNotFound(
    ownerSlug: string,
    subslug: string,
    viewer: CurrentUserData | undefined,
  ): Promise<never> {
    const previousOwnerUserId =
      await this.handles.previousProfileOwnerOf(ownerSlug);
    if (!previousOwnerUserId) {
      throw new NotFoundException('Profile not found');
    }
    const moved = await this.profiles.findOne({
      where: { userId: previousOwnerUserId },
    });
    if (!moved) {
      throw new NotFoundException('Profile not found');
    }
    const sp = await this.subprofiles.findOne({
      where: {
        slug: subslug,
        userId: moved.userId,
        linkVisibility: SubprofileLinkVisibility.Linked,
      },
    });
    if (!sp) {
      throw new NotFoundException('Profile not found');
    }
    await this.assertMovedTargetVisibleOrNotFound(
      sp,
      viewer,
      'Profile not found',
    );
    // Same payload the username routes emit, so the SPA reads one shape: the
    // frontend rebuilds `/members/<slug>/<subslug>` by swapping the owner
    // segment and leaving the persona segment where it was.
    throw new NotFoundException({
      code: 'PROFILE_MOVED',
      message: 'That username has moved',
      slug: moved.slug,
    });
  }

  /**
   * "May this viewer see this persona at all?", per the Shared Contract rule
   * order (design plan Phase 1b Task 1). Returns for a viewer who may; throws
   * for one who may not.
   *
   * An owner/co-owner sees the persona regardless of status/visibility
   * (including a draft — `SubprofilePublicView.status` then reads `"draft"`,
   * driving the frontend's draft banner). Everyone else is gated in order:
   * `removedAt` set → 403 `removed`; not published → 404 (an unpublished draft
   * is invisible to a non-owner, never a distinct restricted state); `private`
   * → 403 `private`; `network` and the viewer isn't an authenticated active
   * member → 403 `members_only`; a moderator takedown → 404; blocked either
   * way → 404.
   *
   * Its own method because PRD-204's forwarding has to reach the SAME verdict
   * before it will name a persona it is about to send someone to
   * (`assertMovedTargetVisibleOrNotFound`). A second, hand-copied spelling of
   * this order would be a visibility rule that could drift, and a drift here
   * turns a moved address into a way to confirm a withheld persona exists.
   */
  private async assertPublicViewVisible(
    sp: Subprofile,
    viewer: CurrentUserData | undefined,
    isOwner: boolean,
  ): Promise<void> {
    if (isOwner) {
      return;
    }
    if (sp.removedAt) {
      throw new ForbiddenException(restrictedAccessBody('removed'));
    }
    if (sp.status !== SubprofileStatus.Published) {
      throw new NotFoundException('Subprofile not found');
    }
    if (sp.visibility === SubprofileVisibility.Private) {
      throw new ForbiddenException(restrictedAccessBody('private'));
    }
    if (
      sp.visibility === SubprofileVisibility.Network &&
      viewer?.status !== UserStatus.Active
    ) {
      throw new ForbiddenException(restrictedAccessBody('members_only'));
    }
    // Pre-existing moderator-takedown withhold — a SEPARATE mechanism from
    // `removedAt` above (see the migration's comment / Non-goals): a
    // hidden/removed `content_moderation` row still 404s for non-owners,
    // the same withhold-entirely behaviour the directory/search reads
    // share. Owner-facing reads don't re-check this state (mirrors
    // `listMine`/`getOwned`), so the owner still sees + manages their
    // persona even under a takedown.
    const moderation = await this.contentModeration.stateFor(
      SubprofilePublicReadService.SUBJECT_TYPE,
      sp.slug,
    );
    if (moderation.hidden || moderation.removed) {
      throw new NotFoundException('Subprofile not found');
    }
    // Never surface the persona of someone the viewer has blocked (either
    // way). Skipped entirely for an anonymous viewer — there is no account
    // to have blocked anyone.
    if (
      viewer &&
      (await this.blockFilter.isBlockedEitherWay(viewer.userId, sp.userId))
    ) {
      throw new NotFoundException('Subprofile not found');
    }
  }

  // Shared by `getByHandle` and `getBySlugForProfile`: resolves whether
  // `viewer` may see `sp` at all (`assertPublicViewVisible` above), then
  // assembles the full public DTO.
  private async buildPublicView(
    sp: Subprofile,
    viewer: CurrentUserData | undefined,
    ownerRef: SubprofileOwnerRef | undefined,
  ): Promise<SubprofilePublicView> {
    const isOwner = viewer
      ? await this.membership.isMember(viewer.userId, sp.id)
      : false;

    await this.assertPublicViewVisible(sp, viewer, isOwner);

    const viewerId = viewer?.userId ?? ANONYMOUS_VIEWER_ID;
    // These seven reads are mutually independent — fire them in one round trip
    // rather than seven sequential awaits.
    const [
      items,
      socialLinkRows,
      endorsementCountsById,
      viewerEndorsedIds,
      followerCountsById,
      viewerFollowingIds,
      affiliationsById,
    ] = await Promise.all([
      this.items.find({ where: { subprofileId: sp.id } }),
      this.socialLinks.find({
        where: { subprofileId: sp.id },
        order: { position: 'ASC' },
      }),
      this.endorsementsService.loadEndorsementCountsFor([sp.id]),
      this.endorsementsService.viewerEndorsedFor(viewerId, [sp.id]),
      this.followersService.loadFollowerCountsFor([sp.id]),
      this.followersService.viewerFollowingFor(viewerId, [sp.id]),
      this.resolveAffiliationsFor(viewerId, [sp.id]),
    ]);
    const endorsementCount = endorsementCountsById.get(sp.id) ?? 0;
    const viewerEndorsed = viewerEndorsedIds.has(sp.id);
    const followerCount = followerCountsById.get(sp.id) ?? 0;
    const viewerFollowing = viewerFollowingIds.has(sp.id);
    const affiliations = affiliationsById.get(sp.id) ?? [];
    // Depends on `items`, so it follows the batch rather than joining it.
    const collaboratorsByHandle = await this.resolveCollaboratorsFor(
      viewerId,
      items,
    );
    const crops = await this.mediaCropService.getMany(imageKeysFor(sp, items));
    return toPublicDTO(
      sp,
      items,
      ownerRef,
      socialLinkRows,
      endorsementCount,
      viewerEndorsed,
      followerCount,
      viewerFollowing,
      affiliations,
      collaboratorsByHandle,
      isOwner,
      crops,
    );
  }

  // Directory of standalone (unlinked + published + open) personas.
  async directory(
    query: ListSubprofileDirectoryQuery,
    viewerId: string,
  ): Promise<{
    items: SubprofileCardView[];
    total: number;
    page: number;
    limit: number;
  }> {
    const qb = this.subprofiles
      .createQueryBuilder('sp')
      // Project only what `toCardDTO` (plus the id used to key the batched
      // social-count/tag/follower lookups below) actually reads — this list is
      // now offset-paginated (see below) but was still hydrating full rows,
      // including `bio`, the CTA fields, and the 16KB `skinData` jsonb blob, on
      // every request. `coverUrl` IS read now (the card renders the banner in
      // its header band); it is a short varchar, unlike the blob above.
      .select([
        'sp.id',
        'sp.handle',
        'sp.kind',
        'sp.displayName',
        'sp.avatarUrl',
        'sp.coverUrl',
        'sp.tagline',
        'sp.accent',
        'sp.availability',
        // Inc2 Task A: the directory now includes linked personas too, so the
        // card needs to route them to `/members/:ownerSlug/:slug` — `slug` +
        // `linkVisibility` feed `toCardDTO`, `userId` keys the batched
        // owner-slug lookup below.
        'sp.slug',
        'sp.linkVisibility',
        'sp.userId',
      ])
      .where('sp.status = :published', {
        published: SubprofileStatus.Published,
      })
      .andWhere('sp.visibility = :open', {
        open: SubprofileVisibility.Open,
      })
      // A removed persona is withheld from the directory too (Personas
      // redesign Phase 1b) — only owner-facing reads skip this check.
      .andWhere('sp.removedAt IS NULL');

    // Hide personas of members blocked either way (design spec §4). The raw
    // column reference must match the DB's snake_case name (SnakeNamingStrategy).
    this.blockFilter.excludeBlocked(qb, viewerId, '"sp"."user_id"');
    // Withhold any persona under a moderator takedown, in-query so the capped
    // directory result stays consistent.
    this.excludeModeratedSubprofiles(qb);

    if (query.kind) {
      qb.andWhere('sp.kind = :kind', { kind: query.kind });
    }
    if (query.query) {
      // Escape LIKE metacharacters so the term matches literally.
      const term = `%${query.query.replace(/[\\%_]/g, '\\$&')}%`;
      // The directory carries LINKED personas as well as standalone ones, and
      // a linked card is titled by its owner ("Ana Silva | Poet"), so the name
      // on screen has to be searchable — looking up the poet you met by the
      // name you know them under is the directory's most obvious question, and
      // before this it returned nothing.
      //
      // The owner is joined 1:1 (`profiles.user_id` is the PK), so the join
      // multiplies no rows and `getCount()`/`offset`/`limit` below stay exact.
      // It is added ONLY on the search path: an unsearched browse pays nothing.
      qb.leftJoin(Profile, 'owner', 'owner.userId = sp.userId');
      // The owner branch is gated on `linkVisibility = linked`, the SAME rule
      // that decides whether `toCardDTO` fills `ownerName`/`ownerSlug` at all.
      // An unlinked persona's owner is deliberately unnamed on the card, and
      // making it matchable here would leak that tie back out through the
      // result set: search "Ana Silva", get the anonymous persona she runs.
      //
      // Folded rather than a bare ILIKE (`foldedHaystack` — the member
      // directory's own vocabulary), because this audience writes Portuguese
      // and "Joao"/"Ines" have to find "João"/"Inês". First name, last name and
      // profile slug are concatenated into ONE haystack, so a full name typed
      // as "ana silva" matches across the two columns rather than neither.
      // The persona's own name/tagline keep their plain ILIKE: those two
      // columns carry GIN trigram indexes built on the unfolded values, and
      // folding them here would silently stop using them.
      qb.andWhere(
        '(sp.displayName ILIKE :term OR sp.tagline ILIKE :term OR ' +
          `(sp.linkVisibility = :linkedForSearch AND ${OWNER_SEARCH_HAYSTACK} ` +
          `LIKE ${foldedSearchTerm('ownerTerm')}))`,
        {
          term,
          ownerTerm: term,
          linkedForSearch: SubprofileLinkVisibility.Linked,
        },
      );
    }

    // Offset pagination (replaces the fixed `take: DIRECTORY_RESULT_CAP`
    // full-catalogue materialisation): 1-based `page`, `limit` bounded by the
    // DTO's `@Max(DIRECTORY_MAX_LIMIT)` and defaulted, so a browse never pulls
    // the whole table (plus its per-row social-count/tag/follower fan-out) into
    // one response. `displayName ASC` is stable enough to page over for this
    // ordered browse.
    const page = query.page ?? 1;
    const limit = Math.min(
      query.limit ?? DIRECTORY_DEFAULT_LIMIT,
      DIRECTORY_MAX_LIMIT,
    );
    // Total matching the SAME filtered query (block filter + kind/text + removed/
    // moderated exclusions) BEFORE the page window, so the FE can loop pages
    // using `total` instead of assuming it received the whole set (the bug this
    // fixes). `getCount()` ignores `orderBy`/`offset`/`limit`, so it is computed
    // here — before those are applied — purely for readability.
    const total = await qb.getCount();
    // Display names are not unique, so an OFFSET page boundary landing inside a
    // tie repeats or skips a persona. `sp.id` is unique and makes the total
    // order deterministic across pages (same tiebreak as
    // `CommunitiesService.list`'s 'name' sort). Both are entity property paths
    // on the selected alias, never an `addSelect` alias, so TypeORM quotes the
    // snake_case columns itself.
    qb.orderBy('sp.displayName', 'ASC')
      .addOrderBy('sp.id', 'ASC')
      .offset((page - 1) * limit)
      .limit(limit);
    const rows = await qb.getMany();
    const rowIds = rows.map((row) => row.id);
    // Inc2 Task A: the directory now includes linked rows, so resolve the
    // owner's profile slug for those — ONE grouped query over the page's
    // linked userIds (never per-card), mirroring the socialCount/tags/
    // followerCount batches below. Skipped entirely when the page has no
    // linked rows.
    const linkedUserIds = [
      ...new Set(
        rows
          .filter(
            (row) => row.linkVisibility === SubprofileLinkVisibility.Linked,
          )
          .map((row) => row.userId),
      ),
    ];
    // The four per-page fan-out reads are mutually independent — batched into
    // one round trip. Each is ONE grouped query over the page's ids, never
    // per-card (Personas redesign Phase 4, design plan Decision §3).
    const [
      socialCountsById,
      tagsById,
      followerCountsById,
      ownerProfiles,
      crops,
    ] = await Promise.all([
      this.loadSocialCountsFor(rowIds),
      this.loadContentTagsFor(rowIds),
      this.followersService.loadFollowerCountsFor(rowIds),
      linkedUserIds.length > 0
        ? this.profiles.find({
            where: { userId: In(linkedUserIds) },
            // The name parts ride along for the card's "Owner Name | Poet"
            // title on a persona still named after its profession — two extra
            // columns on the query that already resolves `ownerSlug`, never a
            // new read. Composed exactly like `SubprofileOwnerRef.name` above.
            select: ['userId', 'slug', 'firstName', 'lastName'],
          })
        : Promise.resolve([]),
      // ONE batched crop lookup for every card's avatar AND banner on the page
      // — never a per-card query, and one call for both keys rather than two.
      this.mediaCropService.getMany(
        rows.flatMap((row) =>
          [row.avatarUrl, row.coverUrl].filter((key): key is string =>
            Boolean(key),
          ),
        ),
      ),
    ]);
    const ownerSlugByUserId = new Map(
      ownerProfiles.map((profile) => [profile.userId, profile.slug]),
    );
    // An owner with both name parts blank composes to "", which would title a
    // card as " | Poet" — normalised to null so the persona keeps its bare name.
    const ownerNameByUserId = new Map(
      ownerProfiles.map((profile) => [
        profile.userId,
        `${profile.firstName} ${profile.lastName}`.trim() || null,
      ]),
    );
    return {
      items: rows.map((row) =>
        toCardDTO(
          row,
          socialCountsById.get(row.id) ?? 0,
          tagsById.get(row.id) ?? [],
          followerCountsById.get(row.id) ?? 0,
          ownerSlugByUserId.get(row.userId) ?? null,
          crops,
          ownerNameByUserId.get(row.userId) ?? null,
        ),
      ),
      total,
      page,
      limit,
    };
  }

  // Cross-entity global search (SearchService) — standalone personas only
  // (unlinked + published + open + handle-bearing), mirroring `directory`'s
  // WHERE + block filter. ILIKE over displayName / tagline. Returns the public
  // `handle` (the persona's /p/:handle identifier) — never the owner tie.
  async searchByText(
    viewerId: string,
    term: string,
    limit: number,
  ): Promise<SubprofileSearchRow[]> {
    const pattern = `%${escapeLikeTerm(term)}%`;
    const qb = this.subprofiles
      .createQueryBuilder('sp')
      .where('sp.linkVisibility = :linked', {
        linked: SubprofileLinkVisibility.Unlinked,
      })
      .andWhere('sp.status = :published', {
        published: SubprofileStatus.Published,
      })
      .andWhere('sp.visibility = :open', {
        open: SubprofileVisibility.Open,
      })
      .andWhere('sp.handle IS NOT NULL')
      // A removed persona is withheld from search too (mirrors `directory`;
      // Personas redesign Phase 1b).
      .andWhere('sp.removedAt IS NULL')
      .andWhere(
        '(sp.displayName ILIKE :pattern OR sp.tagline ILIKE :pattern)',
        {
          pattern,
        },
      );
    // Hide personas of members blocked either way (mirrors `directory`). The
    // raw column reference must match the DB's snake_case name.
    this.blockFilter.excludeBlocked(qb, viewerId, '"sp"."user_id"');
    // Withhold any persona under a moderator takedown (mirrors `directory`).
    this.excludeModeratedSubprofiles(qb);
    const rows = await qb
      .orderBy('sp.displayName', 'ASC')
      .take(limit)
      .getMany();
    return rows.map(toSubprofileSearchRow);
  }

  // Public, unauthenticated enumeration of every crawlable persona handle —
  // feeds the sitemap generator + the Playwright prerenderer (design plan
  // Phase 4b). Mirrors `directory`'s WHERE (unlinked + published + open +
  // handle set) but WITHOUT the block filter: there is no viewer here, this
  // is public SEO data, not a personalized read. Capped + newest-first so a
  // huge catalogue still yields a bounded, most-recently-updated sitemap.
  async listPublicHandles(): Promise<{
    items: { handle: string; updatedAt: string }[];
  }> {
    const rows = await this.subprofiles.find({
      where: {
        linkVisibility: SubprofileLinkVisibility.Unlinked,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
        handle: Not(IsNull()),
        // A removed persona is withheld from the sitemap/prerender set too
        // (Personas redesign Phase 1b).
        removedAt: IsNull(),
      },
      // `slug` is selected purely so the takedown filter below can key on it —
      // it is not emitted in the sitemap payload.
      select: { handle: true, updatedAt: true, slug: true },
      order: { updatedAt: 'DESC' },
      take: 5000,
    });
    // A taken-down persona must not appear in the public sitemap/prerender set.
    const visible = await this.dropModeratedSubprofiles(rows);
    return {
      items: visible.map((row) => ({
        handle: row.handle as string,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  // Batches the resolved event/community links for many personas into TWO
  // entity queries total (one `events.find`, one `communities.find`), never
  // per-affiliation-row or per-persona — mirrors `loadSocialCountsFor` /
  // `loadContentTagsFor`. A target is DROPPED (not surfaced) from the result
  // if it no longer exists, is no longer publicly visible, or its owner is
  // block-filtered against `viewerId` — the read-side mirror of the
  // existence/visibility/block checks `replaceAffiliations` applies at save
  // time, so a target that goes private/gets deleted/becomes blocked after
  // linking silently disappears rather than 500ing or leaking it.
  async resolveAffiliationsFor(
    viewerId: string,
    subprofileIds: string[],
  ): Promise<Map<string, AffiliationView[]>> {
    const affiliationsBySubprofileId = new Map<string, AffiliationView[]>();
    if (!subprofileIds.length) {
      return affiliationsBySubprofileId;
    }
    const rows = await this.affiliations.find({
      where: { subprofileId: In(subprofileIds) },
      order: { position: 'ASC' },
    });
    if (!rows.length) {
      return affiliationsBySubprofileId;
    }

    const eventSlugs = [
      ...new Set(
        rows
          .filter((row) => row.targetType === 'event')
          .map((row) => row.targetSlug),
      ),
    ];
    const communitySlugs = [
      ...new Set(
        rows
          .filter((row) => row.targetType === 'community')
          .map((row) => row.targetSlug),
      ),
    ];

    // The two entity queries — ONE for events, ONE for communities,
    // regardless of how many personas/rows are being resolved.
    const [eventRows, communityRows] = await Promise.all([
      eventSlugs.length
        ? this.events.find({ where: { slug: In(eventSlugs) } })
        : Promise.resolve([]),
      communitySlugs.length
        ? this.communities.find({ where: { slug: In(communitySlugs) } })
        : Promise.resolve([]),
    ]);

    // slug -> resolved (name/imageUrl/ownerId), but ONLY for targets that are
    // still publicly visible (mirrors the criteria `EventsService` /
    // `CommunitiesService` use for their own public reads) — an invisible
    // target simply has no map entry below, so it is dropped.
    type ResolvedTarget = {
      name: string;
      imageUrl: string | null;
      // Null while the community is temporarily ownerless (owner account
      // erased, pending mod-promotion/reassignment) — there's no owner user
      // left to block-check against, so the target just passes through.
      ownerId: string | null;
    };
    const eventBySlug = new Map<string, ResolvedTarget>(
      eventRows
        .filter(
          (event) =>
            event.status === EventStatus.Published &&
            event.visibility !== EventVisibility.InviteOnly,
        )
        .map((event) => [
          event.slug,
          {
            name: event.title,
            imageUrl: toImageUrl(event.coverImageUrl),
            ownerId: event.hostId,
          },
        ]),
    );
    const communityBySlug = new Map<string, ResolvedTarget>(
      communityRows
        .filter((community) => community.accessTier !== AccessTier.Private)
        .map((community) => [
          community.slug,
          // Communities have no image column — `imageUrl` is always null.
          { name: community.name, imageUrl: null, ownerId: community.ownerId },
        ]),
    );

    // Batched block-filter over the DISTINCT set of target owners (one query
    // total via `BlockFilterService.blockedUserIds`), not per affiliation row.
    const ownerIds = [
      ...new Set(
        [
          ...[...eventBySlug.values()].map((target) => target.ownerId),
          ...[...communityBySlug.values()].map((target) => target.ownerId),
        ].filter((ownerId): ownerId is string => ownerId !== null),
      ),
    ];
    const blockedOwnerIds = await this.blockFilter.blockedUserIds(
      viewerId,
      ownerIds,
    );

    for (const row of rows) {
      const target =
        row.targetType === 'event'
          ? eventBySlug.get(row.targetSlug)
          : row.targetType === 'community'
            ? communityBySlug.get(row.targetSlug)
            : undefined;
      if (
        !target ||
        (target.ownerId !== null && blockedOwnerIds.has(target.ownerId))
      ) {
        continue;
      }
      const view: AffiliationView = {
        targetType: row.targetType,
        targetSlug: row.targetSlug,
        role: row.role,
        name: target.name,
        imageUrl: target.imageUrl,
      };
      const bucket = affiliationsBySubprofileId.get(row.subprofileId);
      if (bucket) {
        bucket.push(view);
      } else {
        affiliationsBySubprofileId.set(row.subprofileId, [view]);
      }
    }

    return affiliationsBySubprofileId;
  }

  // Batched core resolver for `@handle` collaboration credits (design plan
  // Phase 3d): turns a set of raw handle strings into resolved display cards
  // in a BOUNDED number of queries regardless of how many handles are asked
  // for — ONE `handles` registry lookup, ONE `profiles` lookup, ONE
  // `subprofiles` lookup, and ONE batched block-lookup via
  // `BlockFilterService.blockedUserIds` (mirrors `resolveAffiliationsFor`'s
  // two-entity-query shape). A handle is DROPPED (never surfaced, never
  // throws) when: it isn't registered, its owner is blocked either way with
  // `viewerId`, or — for a persona — it isn't currently published +
  // unlinked + non-private (a linked persona is nested under its owner and
  // is NOT creditable; a private persona isn't discoverable by handle to
  // just anyone). Callers that must reject an unresolvable handle (the
  // owner-facing validation in `replaceSection`) check the returned map's
  // membership themselves — this resolver only ever narrows, never throws.
  async resolveHandles(
    handleNames: string[],
    viewerId: string,
  ): Promise<Map<string, CollaboratorView>> {
    const collaboratorByHandle = new Map<string, CollaboratorView>();
    const normalizedHandles = [
      ...new Set(handleNames.map((handleName) => normalizeHandle(handleName))),
    ];
    if (!normalizedHandles.length) {
      return collaboratorByHandle;
    }

    const handleRows = await this.handleRegistry.find({
      where: { name: In(normalizedHandles) },
    });
    if (!handleRows.length) {
      return collaboratorByHandle;
    }

    const profileUserIds = [
      ...new Set(
        handleRows
          .filter(
            (row) => row.ownerKind === HandleOwnerKind.Profile && row.userId,
          )
          .map((row) => row.userId as string),
      ),
    ];
    const subprofileIds = [
      ...new Set(
        handleRows
          .filter(
            (row) =>
              row.ownerKind === HandleOwnerKind.Subprofile && row.subprofileId,
          )
          .map((row) => row.subprofileId as string),
      ),
    ];

    const [profileRows, subprofileRows] = await Promise.all([
      profileUserIds.length
        ? this.profiles.find({ where: { userId: In(profileUserIds) } })
        : Promise.resolve([]),
      subprofileIds.length
        ? this.subprofiles.find({ where: { id: In(subprofileIds) } })
        : Promise.resolve([]),
    ]);

    const profileByUserId = new Map(
      profileRows.map((profile) => [profile.userId, profile]),
    );
    const subprofileById = new Map(
      subprofileRows.map((subprofile) => [subprofile.id, subprofile]),
    );

    // ONE batched block-lookup over every candidate owner (a credited
    // member's own userId, or a credited persona's owner userId) — never a
    // per-handle query.
    const candidateOwnerIds = [
      ...new Set([
        ...profileRows.map((profile) => profile.userId),
        ...subprofileRows.map((subprofile) => subprofile.userId),
      ]),
    ];
    const blockedOwnerIds = await this.blockFilter.blockedUserIds(
      viewerId,
      candidateOwnerIds,
    );

    for (const handleRow of handleRows) {
      if (handleRow.ownerKind === HandleOwnerKind.Profile && handleRow.userId) {
        const profile = profileByUserId.get(handleRow.userId);
        if (!profile || blockedOwnerIds.has(profile.userId)) {
          continue;
        }
        collaboratorByHandle.set(handleRow.name, {
          handle: handleRow.name,
          type: 'member',
          name: `${profile.firstName} ${profile.lastName}`.trim(),
          // A credited MEMBER's face honours their own `photoVisible` toggle,
          // through the shared gate `toMemberRef` uses, so a credit agrees
          // with feed and forum. `CollaboratorView` is a narrower shape than
          // `MemberRef` (it also covers credited personas, which have no
          // profile row), so it calls the gate directly. The persona branch
          // below is unaffected: a persona avatar is the persona's own image,
          // never a member's face.
          avatarUrl: toVisibleAvatarUrl(profile),
          slug: profile.slug,
        });
      } else if (
        handleRow.ownerKind === HandleOwnerKind.Subprofile &&
        handleRow.subprofileId
      ) {
        const persona = subprofileById.get(handleRow.subprofileId);
        // Creditable ONLY when published + unlinked + not private + not
        // removed: a linked persona is nested under its owner (not
        // creditable — see the phase note), a draft doesn't exist publicly
        // yet, a private persona isn't meant to be namelinked from someone
        // else's page, and a removed persona is withheld like every other
        // public read (Personas redesign Phase 1b).
        if (
          !persona ||
          persona.status !== SubprofileStatus.Published ||
          persona.linkVisibility !== SubprofileLinkVisibility.Unlinked ||
          persona.visibility === SubprofileVisibility.Private ||
          persona.removedAt ||
          blockedOwnerIds.has(persona.userId)
        ) {
          continue;
        }
        collaboratorByHandle.set(handleRow.name, {
          handle: handleRow.name,
          type: 'persona',
          name: persona.displayName,
          avatarUrl: toImageUrl(persona.avatarUrl),
          slug: null,
        });
      }
    }

    return collaboratorByHandle;
  }

  // Gathers every item's `collaborators` handles across a set of items (one
  // persona's items, or many personas' items pooled together by a caller
  // like `listMine`/`listForProfile`) into a SINGLE `resolveHandles` call, so
  // a multi-persona read resolves the whole page's collaborators in one
  // batched pass rather than once per persona.
  async resolveCollaboratorsFor(
    viewerId: string,
    items: SubprofileItem[],
  ): Promise<Map<string, CollaboratorView>> {
    const handleNames = items.flatMap((item) => item.collaborators ?? []);
    return this.resolveHandles(handleNames, viewerId);
  }

  async loadItemsFor(ids: string[]): Promise<Map<string, SubprofileItem[]>> {
    const byId = new Map<string, SubprofileItem[]>();
    if (!ids.length) {
      return byId;
    }
    const rows = await this.items.find({
      where: { subprofileId: In(ids) },
    });
    for (const row of rows) {
      const bucket = byId.get(row.subprofileId);
      if (bucket) {
        bucket.push(row);
      } else {
        byId.set(row.subprofileId, [row]);
      }
    }
    return byId;
  }

  // Batches the social-link rows for many subprofiles into ONE query (mirrors
  // `loadItemsFor`) — avoids an N+1 in `listMine`/`listForProfile`.
  async loadSocialLinksFor(
    subprofileIds: string[],
  ): Promise<Map<string, SubprofileSocialLink[]>> {
    const socialLinksBySubprofileId = new Map<string, SubprofileSocialLink[]>();
    if (!subprofileIds.length) {
      return socialLinksBySubprofileId;
    }
    const rows = await this.socialLinks.find({
      where: { subprofileId: In(subprofileIds) },
      order: { position: 'ASC' },
    });
    for (const row of rows) {
      const bucket = socialLinksBySubprofileId.get(row.subprofileId);
      if (bucket) {
        bucket.push(row);
      } else {
        socialLinksBySubprofileId.set(row.subprofileId, [row]);
      }
    }
    return socialLinksBySubprofileId;
  }

  // Batches a per-subprofile social-link COUNT into ONE query (used by
  // `directory`, which only needs the count, not the rows themselves).
  private async loadSocialCountsFor(
    subprofileIds: string[],
  ): Promise<Map<string, number>> {
    const socialCountsBySubprofileId = new Map<string, number>();
    if (!subprofileIds.length) {
      return socialCountsBySubprofileId;
    }
    // Grouped SQL COUNT — one row per persona out of Postgres, rather than
    // pulling every social-link row into the app to tally.
    const rows = await this.socialLinks
      .createQueryBuilder('socialLink')
      .select('socialLink.subprofileId', 'subprofileId')
      .addSelect('COUNT(*)', 'count')
      .where('socialLink.subprofileId IN (:...subprofileIds)', {
        subprofileIds,
      })
      .groupBy('socialLink.subprofileId')
      .getRawMany<{ subprofileId: string; count: string }>();
    for (const row of rows) {
      socialCountsBySubprofileId.set(row.subprofileId, Number(row.count));
    }
    return socialCountsBySubprofileId;
  }

  // Batches distinct, non-links content tags per subprofile into ONE query
  // (mirrors `loadSocialCountsFor`) — avoids an N+1 in `directory`. Caps each
  // subprofile's tag list at 12, deduped.
  private async loadContentTagsFor(
    subprofileIds: string[],
  ): Promise<Map<string, string[]>> {
    const tagsBySubprofileId = new Map<string, string[]>();
    if (!subprofileIds.length) {
      return tagsBySubprofileId;
    }
    const rows = await this.items.find({
      where: {
        subprofileId: In(subprofileIds),
        section: Not(SubprofileSection.Links),
      },
      select: { subprofileId: true, tags: true },
    });
    for (const row of rows) {
      const existing = tagsBySubprofileId.get(row.subprofileId) ?? [];
      for (const tag of row.tags ?? []) {
        if (existing.length < 12 && !existing.includes(tag)) {
          existing.push(tag);
        }
      }
      tagsBySubprofileId.set(row.subprofileId, existing);
    }
    return tagsBySubprofileId;
  }
}
