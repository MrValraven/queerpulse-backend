import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import {
  DataSource,
  In,
  IsNull,
  Not,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { normalizeHandle } from '../common/handles';
import { escapeLikeTerm } from '../common/like-escape';
import { toImageUrl } from '../common/image-url';
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
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { CreateSubprofileDTO } from './dto/create-subprofile.dto';
import { ListDirectoryQuery } from './dto/list-directory.query';
import { SubprofileItemInputDTO } from './dto/replace-items.dto';
import { UpdateSubprofileDTO } from './dto/update-subprofile.dto';
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
import { isSectionAllowed } from './subprofile-kinds';
import {
  ACCENT_KEYS,
  AVAILABILITY_KEYS,
  isValidAffiliation,
  MAX_AFFILIATIONS,
  MAX_COLLABORATORS_PER_ITEM,
  MAX_ITEMS_PER_SECTION,
  MAX_SUBPROFILES,
  slugifyDisplayName,
  validatePublish,
  validateSocialLinks,
} from './subprofile-validation';
import {
  AffiliationView,
  CollaboratorView,
  EndorserView,
  SubprofileCardView,
  SubprofilePublicView,
  SubprofileSearchRow,
  SubprofileView,
  toCardDTO,
  toPublicDTO,
  toSubprofileDTO,
  toSubprofileSearchRow,
} from './subprofile-response';
import { MemberView, toMemberView } from './subprofile-invite-response';

// Hard upper bound on how many personas the authenticated `directory` browse
// materialises in one go — matches `listPublicHandles`'s `take: 5000` so an
// unbounded catalogue can never pull every published-unlinked-open persona
// (plus its per-row social-count / tag fan-out) into one response.
const DIRECTORY_RESULT_CAP = 5000;

@Injectable()
export class SubprofilesService {
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
    private readonly dataSource: DataSource,
    private readonly blockFilter: BlockFilterService,
    private readonly handles: HandlesService,
    private readonly endorsementsService: SubprofileEndorsementsService,
    private readonly followersService: SubprofileFollowersService,
    // Read-only: a `hide_content`/`remove_content` takedown on a `subprofile`
    // subject (keyed by the persona slug — what the frontend report control
    // sends) withholds the persona from every public read below.
    private readonly contentModeration: ContentModerationService,
  ) {}

  // A persona is reported (and taken down) under the `subprofile` subject code,
  // keyed by its slug. A hidden OR removed persona vanishes from every public
  // read (profile-nested, by-handle, directory, search, sitemap) for everyone —
  // a public surface with no per-viewer staff role, so (like the directory) a
  // takedown withholds it entirely. Owner-facing reads (`listMine`/`getOwned`)
  // don't re-check this state, so the owner still sees + manages their persona.
  private static readonly SUBJECT_TYPE = 'subprofile';

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
      { subprofileSubjectType: SubprofilesService.SUBJECT_TYPE },
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
      SubprofilesService.SUBJECT_TYPE,
      rows.map((row) => row.slug),
    );
    return rows.filter((row) => {
      const state = states.get(row.slug);
      return !state || (!state.hidden && !state.removed);
    });
  }

  // ---- owner reads ---------------------------------------------------------

  async listMine(userId: string): Promise<SubprofileView[]> {
    // Co-owner-aware: list every persona this member belongs to via
    // `subprofile_members`, not only ones they created (`sp.userId`). Mirrors
    // the `isMember` gate backing `getOwned`.
    const memberRows = await this.members.find({
      where: { userId },
      select: { subprofileId: true },
    });
    const ids = memberRows.map((row) => row.subprofileId);
    const sps = ids.length
      ? await this.subprofiles.find({
          where: { id: In(ids) },
          order: { position: 'ASC', createdAt: 'ASC' },
        })
      : [];
    const subprofileIds = sps.map((sp) => sp.id);
    const itemsById = await this.loadItemsFor(subprofileIds);
    const socialLinksById = await this.loadSocialLinksFor(subprofileIds);
    const endorsementCountsById =
      await this.endorsementsService.loadEndorsementCountsFor(subprofileIds);
    // Owner viewing their own personas: resolve ALL items' collaborator
    // handles across every subprofile in ONE batched call, shared by every
    // mapper invocation below (no per-persona resolution).
    const collaboratorsByHandle = await this.resolveCollaboratorsFor(
      userId,
      [...itemsById.values()].flat(),
    );
    return sps.map((sp) =>
      toSubprofileDTO(
        sp,
        itemsById.get(sp.id) ?? [],
        socialLinksById.get(sp.id) ?? [],
        endorsementCountsById.get(sp.id) ?? 0,
        0,
        [],
        collaboratorsByHandle,
      ),
    );
  }

  // Co-owner-aware membership check backing `getOwned`: any row in
  // `subprofile_members` for this (userId, subprofileId) pair passes, not
  // just the original creator (`sp.userId`).
  private async isMember(
    userId: string,
    subprofileId: string,
  ): Promise<boolean> {
    const row = await this.members.findOne({
      where: { subprofileId, userId },
      select: { id: true },
    });
    return row !== null;
  }

  async getOwned(userId: string, id: string): Promise<Subprofile> {
    const sp = await this.subprofiles.findOne({ where: { id } });
    if (!sp) {
      throw new NotFoundException('Subprofile not found');
    }
    if (!(await this.isMember(userId, id))) {
      throw new ForbiddenException('Not your subprofile');
    }
    return sp;
  }

  // Public membership gate (404/403) for other services (e.g.
  // `SubprofileInvitesService`) that need the same check `getOwned` already
  // does, without exposing the private `isMember` boolean helper itself.
  async assertMember(
    userId: string,
    subprofileId: string,
  ): Promise<Subprofile> {
    return this.getOwned(userId, subprofileId);
  }

  async getOwnedDTO(userId: string, id: string): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);
    return this.ownerDTO(sp);
  }

  // List a persona's co-owners (members-gated). Batches the profile lookup
  // into ONE query regardless of how many co-owners the persona has.
  async listMembers(userId: string, id: string): Promise<MemberView[]> {
    const sp = await this.getOwned(userId, id); // 404/403 gate
    const memberRows = await this.members.find({
      where: { subprofileId: id },
      order: { joinedAt: 'ASC' },
    });
    const profileRows = await this.profiles.find({
      where: { userId: In(memberRows.map((row) => row.userId)) },
    });
    const profileByUserId = new Map(profileRows.map((p) => [p.userId, p]));
    return memberRows
      .filter((row) => profileByUserId.has(row.userId))
      .map((row) =>
        toMemberView(row, profileByUserId.get(row.userId)!, sp.userId),
      );
  }

  // A co-owner leaves the persona. The last remaining member cannot leave —
  // they must delete the persona instead (mirrors `remove`'s cascade).
  //
  // The count-then-delete is wrapped in ONE transaction that first takes the
  // SAME `SELECT ... FOR UPDATE` lock on the persona row that
  // `SubprofileInvitesService.invite()`/`accept()` take, so two co-owners of a
  // 2-member persona leaving at the same instant can never both read
  // count === 2 and both delete — serialized instead, the second leave
  // re-counts under the lock and correctly sees count === 1 (the ConflictException
  // last-owner guard), rather than the persona ending up with zero members
  // (bricked: `getOwned` then 403s everyone, including `remove()`).
  async leave(userId: string, id: string): Promise<void> {
    await this.getOwned(userId, id); // 404/403 gate (must be a member)
    await this.dataSource.transaction(async (manager) => {
      // Lock the persona row FIRST — same lock `invite()`/`accept()` take, so
      // a concurrent leave/invite/accept on this subprofile never interleaves.
      await manager.findOne(Subprofile, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      const count = await manager.count(SubprofileMember, {
        where: { subprofileId: id },
      });
      if (count <= 1) {
        throw new ConflictException(
          'You are the only owner — delete the persona instead of leaving.',
        );
      }
      await manager.delete(SubprofileMember, { subprofileId: id, userId });
    });
  }

  // ---- owner mutations -----------------------------------------------------

  async create(
    userId: string,
    dto: CreateSubprofileDTO,
  ): Promise<SubprofileView> {
    const count = await this.subprofiles.count({ where: { userId } });
    if (count >= MAX_SUBPROFILES) {
      throw new BadRequestException(
        `You can have at most ${MAX_SUBPROFILES} subprofiles`,
      );
    }
    const slug = await this.generateSlug(userId, dto.displayName);
    const sp = this.subprofiles.create({
      userId,
      kind: dto.kind,
      displayName: dto.displayName,
      slug,
    });
    // The creator is always the persona's first member, so `getOwned`'s
    // membership check passes for them immediately (Task 6 will add a way to
    // invite co-owners onto this same `subprofile_members` table). Saved in
    // ONE transaction with the subprofile itself — a crash between the two
    // writes would otherwise leave a subprofile with no membership row,
    // which then 403s its own creator via `getOwned`'s membership gate.
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.save(sp);
        await manager.save(
          this.members.create({ subprofileId: sp.id, userId }),
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Duplicate slug (per owner) or handle (global) — surface as 409 so
        // the client re-picks (design spec §7). Mirrors `saveSubprofile`'s
        // translation; inlined here (rather than delegating to
        // `saveSubprofile`) because this write must share ONE transaction
        // with the membership insert above.
        throw new ConflictException('slug or handle already in use');
      }
      throw err;
    }
    return toSubprofileDTO(sp, []);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateSubprofileDTO,
  ): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);
    const prevLink = sp.linkVisibility;
    const prevHandle = sp.handle;
    // A registry row exists for this persona IFF it is published + unlinked (see
    // the invariant documented on `publish`), and its name equals `prevHandle`.
    const wasPublishedUnlinked =
      sp.status === SubprofileStatus.Published &&
      prevLink === SubprofileLinkVisibility.Unlinked;
    const { linkVisibility, ...rest } = dto;

    if (
      rest.accent !== undefined &&
      rest.accent !== null &&
      !ACCENT_KEYS.includes(rest.accent as (typeof ACCENT_KEYS)[number])
    ) {
      throw new BadRequestException(`Unknown accent: ${rest.accent}`);
    }
    if (
      rest.availability !== undefined &&
      rest.availability !== null &&
      !AVAILABILITY_KEYS.includes(
        rest.availability as (typeof AVAILABILITY_KEYS)[number],
      )
    ) {
      throw new BadRequestException(
        `Unknown availability: ${rest.availability}`,
      );
    }

    Object.assign(sp, rest);

    // ctaLabel/ctaUrl are a pair: a contact CTA needs both a label and a target,
    // never just one — checked against the merged (post-assign) state so a PATCH
    // that only touches one field is still validated against whatever the other
    // field ends up holding (either just-updated or carried over unchanged).
    const hasCtaLabel =
      typeof sp.ctaLabel === 'string' && sp.ctaLabel.trim().length > 0;
    const hasCtaUrl =
      typeof sp.ctaUrl === 'string' && sp.ctaUrl.trim().length > 0;
    if (hasCtaLabel !== hasCtaUrl) {
      throw new BadRequestException('ctaLabel and ctaUrl must be set together');
    }

    // Global-namespace names to free as a side effect of this update.
    const releases: string[] = [];

    if (linkVisibility && linkVisibility !== prevLink) {
      sp.linkVisibility = linkVisibility;
      if (linkVisibility === SubprofileLinkVisibility.Linked) {
        // unlinked → linked: it becomes nested and drops its global handle. If
        // it was a published unlinked persona, free the name it held.
        if (wasPublishedUnlinked && prevHandle) {
          releases.push(prevHandle);
        }
        sp.handle = null;
      } else {
        // linked → unlinked: must re-pass the completeness check before it can
        // (re)publish and claim a handle — leave it unpublished until then.
        sp.status = SubprofileStatus.Draft;
      }
    } else if (wasPublishedUnlinked && prevHandle && sp.handle !== prevHandle) {
      // RULE (chosen): changing the `handle` of an already-published, UNLINKED
      // persona invalidates its live listing. Mirroring the existing
      // "must re-validate" rule, we revert it to DRAFT and RELEASE the old
      // registry name now; the claim happens (under the new name) on the next
      // publish, never here. No release/reclaim churn while it stays a draft.
      sp.status = SubprofileStatus.Draft;
      releases.push(prevHandle);
    }

    if (releases.length) {
      try {
        await this.dataSource.transaction(async (m) => {
          for (const name of releases) {
            await this.handles.release(m, name, {
              kind: 'subprofile',
              subprofileId: sp.id,
            });
          }
          await m.save(sp);
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('slug or handle already in use');
        }
        throw err;
      }
    } else {
      await this.saveSubprofile(sp);
    }
    return this.ownerDTO(sp);
  }

  async replaceSection(
    userId: string,
    id: string,
    section: string,
    items: SubprofileItemInputDTO[],
  ): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);

    if (
      !Object.values(SubprofileSection).includes(section as SubprofileSection)
    ) {
      throw new BadRequestException(`Unknown section: ${section}`);
    }
    const sectionEnum = section as SubprofileSection;
    if (!isSectionAllowed(sp.kind, sectionEnum)) {
      throw new BadRequestException(
        `Section "${section}" is not valid for kind "${sp.kind}"`,
      );
    }
    if (items.length > MAX_ITEMS_PER_SECTION) {
      throw new BadRequestException(
        `A section can have at most ${MAX_ITEMS_PER_SECTION} items`,
      );
    }
    // At most one featured item may arrive in a single section payload. Checked
    // up front (before the delete/insert) so a bad payload fails fast.
    const incomingFeaturedCount = items.filter((it) => it.isFeatured).length;
    if (incomingFeaturedCount > 1) {
      throw new BadRequestException('Only one item can be featured');
    }

    // Collaboration credits: normalize + dedup each item's handle list and
    // cap it, then resolve every handle in the WHOLE section payload in ONE
    // batched `resolveHandles` call — using the OWNER as the viewer, so an
    // owner can only credit a member/persona that is visible + not blocked
    // to them. A handle that fails to resolve 400s before anything is
    // written (no partial writes on a bad payload).
    const normalizedCollaboratorsByItemIndex = items.map((it) => {
      const normalized = [
        ...new Set(
          (it.collaborators ?? []).map((handle) => normalizeHandle(handle)),
        ),
      ];
      if (normalized.length > MAX_COLLABORATORS_PER_ITEM) {
        throw new BadRequestException(
          `An item can credit at most ${MAX_COLLABORATORS_PER_ITEM} collaborators`,
        );
      }
      return normalized;
    });
    const allCollaboratorHandles = normalizedCollaboratorsByItemIndex.flat();
    const collaboratorsByHandle = await this.resolveHandles(
      allCollaboratorHandles,
      sp.userId,
    );
    for (const handle of new Set(allCollaboratorHandles)) {
      if (!collaboratorsByHandle.has(handle)) {
        throw new BadRequestException(
          `Unknown or unavailable collaborator: @${handle}`,
        );
      }
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(SubprofileItem, {
        subprofileId: id,
        section: sectionEnum,
      });
      const rows = items.map((it, index) =>
        manager.create(SubprofileItem, {
          subprofileId: id,
          section: sectionEnum,
          title: it.title,
          subtitle: it.subtitle ?? null,
          description: it.description ?? null,
          url: it.url ?? null,
          imageUrl: it.imageUrl ?? null,
          date: it.date ?? null,
          meta: it.meta ?? null,
          tags: it.tags ?? [],
          collaborators: normalizedCollaboratorsByItemIndex[index],
          isFeatured:
            sectionEnum === SubprofileSection.Links
              ? false
              : (it.isFeatured ?? false),
          position: index,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
      // If this section now holds the spotlight, clear it everywhere else so at
      // most one item across the whole persona is featured. Do NOT clear other
      // sections when the incoming section has no featured item — the spotlight
      // may legitimately live elsewhere.
      if (
        incomingFeaturedCount === 1 &&
        sectionEnum !== SubprofileSection.Links
      ) {
        await manager
          .createQueryBuilder()
          .update(SubprofileItem)
          .set({ isFeatured: false })
          // Raw snake_case column names — an aliasless UpdateQueryBuilder does
          // not map camelCase property names (repo convention: see
          // cinema.service.ts / auth-maintenance.service.ts).
          .where('subprofile_id = :id AND section != :section', {
            id,
            section: sectionEnum,
          })
          .execute();
      }
    });

    return this.ownerDTO(sp);
  }

  async replaceSocialLinks(
    userId: string,
    id: string,
    items: { platform: string; urlOrHandle: string }[],
  ): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);

    if (!validateSocialLinks(items)) {
      throw new BadRequestException('Invalid social links');
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(SubprofileSocialLink, { subprofileId: id });
      const rows = items.map((item, index) =>
        manager.create(SubprofileSocialLink, {
          subprofileId: id,
          platform: item.platform,
          urlOrHandle: item.urlOrHandle,
          position: index,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });

    return this.ownerDTO(sp);
  }

  // Replace-all for a persona's event/community links (design plan Phase 3c).
  // Each target is resolved + validated at SAVE time (must exist, be publicly
  // visible, and not be owned by someone this persona's owner has blocked
  // either way) — mirrors `replaceSocialLinks`'s delete-then-insert shape, but
  // with per-target existence/visibility/block checks `replaceSocialLinks`
  // doesn't need (a social-link platform is just a string, never a live
  // entity). Though bounded at `MAX_AFFILIATIONS` (12), the resolution is
  // batched — the same shape as the READ side (`resolveAffiliationsFor`): ONE
  // events query, ONE communities query, and ONE block-filter lookup total,
  // rather than a serial `findOne` + `isBlockedEitherWay` per item.
  async replaceAffiliations(
    userId: string,
    id: string,
    items: { targetType: string; targetSlug: string; role: string }[],
  ): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);

    if (items.length > MAX_AFFILIATIONS) {
      throw new BadRequestException(
        `You can have at most ${MAX_AFFILIATIONS} affiliations`,
      );
    }
    for (const item of items) {
      if (!isValidAffiliation(item)) {
        throw new BadRequestException(
          `Invalid affiliation: ${item.targetType}:${item.targetSlug}`,
        );
      }
    }

    // Resolve + validate every target before writing anything: existence,
    // public visibility (mirrors the criteria `EventsService`/
    // `CommunitiesService` use for their own public reads), and not
    // block-filtered against this persona's owner. Resolution is BATCHED (one
    // events query, one communities query, one block-filter lookup) — the read
    // side's `resolveAffiliationsFor` shape — rather than a serial `findOne` +
    // `isBlockedEitherWay` per item.
    const eventSlugs = [
      ...new Set(
        items
          .filter((item) => item.targetType === 'event')
          .map((item) => item.targetSlug),
      ),
    ];
    const communitySlugs = [
      ...new Set(
        items
          .filter((item) => item.targetType === 'community')
          .map((item) => item.targetSlug),
      ),
    ];

    const [eventRows, communityRows] = await Promise.all([
      eventSlugs.length
        ? this.events.find({ where: { slug: In(eventSlugs) } })
        : Promise.resolve([]),
      communitySlugs.length
        ? this.communities.find({ where: { slug: In(communitySlugs) } })
        : Promise.resolve([]),
    ]);
    const eventBySlug = new Map(eventRows.map((event) => [event.slug, event]));
    const communityBySlug = new Map(
      communityRows.map((community) => [community.slug, community]),
    );

    // Owners of the targets that pass existence + visibility — the only ones a
    // block could still reject. Batched over the DISTINCT set (one query via
    // `blockedUserIds`, which is block-either-way, same as `isBlockedEitherWay`
    // and as the read side), not one lookup per item.
    const ownerIdsToBlockCheck: string[] = [];
    for (const event of eventRows) {
      if (
        event.status === EventStatus.Published &&
        event.visibility !== EventVisibility.InviteOnly
      ) {
        ownerIdsToBlockCheck.push(event.hostId);
      }
    }
    for (const community of communityRows) {
      if (community.accessTier !== AccessTier.Private) {
        ownerIdsToBlockCheck.push(community.ownerId);
      }
    }
    const blockedOwnerIds = await this.blockFilter.blockedUserIds(
      sp.userId,
      ownerIdsToBlockCheck,
    );

    // Validate in memory, in item order, so the first invalid target still
    // throws with its own label — behaviour-identical to the old serial loop.
    for (const item of items) {
      const label = `${item.targetType}:${item.targetSlug}`;
      if (item.targetType === 'event') {
        const event = eventBySlug.get(item.targetSlug);
        if (
          !event ||
          event.status !== EventStatus.Published ||
          event.visibility === EventVisibility.InviteOnly ||
          blockedOwnerIds.has(event.hostId)
        ) {
          throw new BadRequestException(
            `Affiliation target not found or not visible: ${label}`,
          );
        }
      } else {
        const community = communityBySlug.get(item.targetSlug);
        if (
          !community ||
          community.accessTier === AccessTier.Private ||
          blockedOwnerIds.has(community.ownerId)
        ) {
          throw new BadRequestException(
            `Affiliation target not found or not visible: ${label}`,
          );
        }
      }
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(SubprofileAffiliation, { subprofileId: id });
      const rows = items.map((item, index) =>
        manager.create(SubprofileAffiliation, {
          subprofileId: id,
          targetType: item.targetType,
          targetSlug: item.targetSlug,
          role: item.role,
          position: index,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });

    return this.ownerDTO(sp);
  }

  async publish(userId: string, id: string): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);
    const items = await this.items.find({ where: { subprofileId: id } });
    const socialLinkRows = await this.socialLinks.find({
      where: { subprofileId: id },
      order: { position: 'ASC' },
    });

    const unlinked = sp.linkVisibility === SubprofileLinkVisibility.Unlinked;

    // `handle_taken` now reflects the WHOLE global namespace (main usernames +
    // every other subprofile handle), not just other subprofiles. Excluding
    // this persona's own owner lets a re-publish of the same name pass.
    let handleTaken = false;
    if (unlinked && sp.handle) {
      handleTaken = await this.handles.isTaken(
        this.dataSource.manager,
        sp.handle,
        {
          kind: 'subprofile',
          subprofileId: sp.id,
        },
      );
    }

    const unmet = validatePublish(sp, items, handleTaken);
    if (unmet.length) {
      throw new UnprocessableEntityException({
        code: 'SUBPROFILE_NOT_READY',
        message: 'This persona is not ready to publish yet.',
        unmet,
      });
    }

    if (!unlinked) {
      // Linked personas render nested and never carry a global handle.
      sp.handle = null;
      sp.status = SubprofileStatus.Published;
      await this.saveSubprofile(sp);
      return toSubprofileDTO(sp, items, socialLinkRows);
    }

    // Unlinked: claim the validated handle in the global registry AND flip to
    // published in ONE transaction, so a lost race on the name fails atomically
    // (the row stays a draft). INVARIANT: a registry row exists for a persona
    // IFF it is currently published + unlinked, and that row's name equals its
    // `handle`. So an already-published re-publish renames `handle → handle`
    // (a no-op that keeps the existing claim); a draft renames `null → handle`
    // (a fresh claim).
    const existingClaimedName =
      sp.status === SubprofileStatus.Published ? sp.handle : null;
    try {
      await this.dataSource.transaction(async (m) => {
        await this.handles.rename(m, existingClaimedName, sp.handle!, {
          kind: 'subprofile',
          subprofileId: sp.id,
        });
        await m.update(
          Subprofile,
          { id: sp.id },
          { status: SubprofileStatus.Published },
        );
      });
    } catch (err) {
      // Someone claimed the name between the pre-check and the write. Surface as
      // 422 `handle_taken` to stay consistent with the publish completeness
      // contract (rather than leaking a bare 409).
      if (err instanceof ConflictException) {
        throw new UnprocessableEntityException({
          code: 'SUBPROFILE_NOT_READY',
          message: 'That handle was just taken. Choose another.',
          unmet: ['handle_taken'],
        });
      }
      throw err;
    }
    sp.status = SubprofileStatus.Published;
    return toSubprofileDTO(sp, items, socialLinkRows);
  }

  async unpublish(userId: string, id: string): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);
    if (sp.linkVisibility === SubprofileLinkVisibility.Unlinked && sp.handle) {
      // Free the global name AND null the handle + draft the status in ONE
      // transaction, so the registry and the row can never disagree.
      const handle = sp.handle;
      await this.dataSource.transaction(async (m) => {
        await this.handles.release(m, handle, {
          kind: 'subprofile',
          subprofileId: sp.id,
        });
        await m.update(
          Subprofile,
          { id: sp.id },
          { status: SubprofileStatus.Draft, handle: null },
        );
      });
      sp.status = SubprofileStatus.Draft;
      sp.handle = null;
    } else {
      sp.status = SubprofileStatus.Draft;
      await this.saveSubprofile(sp);
    }
    return this.ownerDTO(sp);
  }

  async remove(userId: string, id: string): Promise<void> {
    const sp = await this.getOwned(userId, id);
    // `subprofile_items` AND the persona's `handles` registry row (if any) both
    // cascade via their FK's ON DELETE CASCADE on `subprofile_id` — deleting the
    // subprofile auto-frees its global handle, so no explicit release is needed.
    await this.subprofiles.remove(sp);
  }

  // ---- public reads --------------------------------------------------------

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
          },
          order: { position: 'ASC', createdAt: 'ASC' },
        })
      : [];
    // Drop any persona under a moderator takedown before it renders nested on
    // the profile.
    const sps = await this.dropModeratedSubprofiles(linkedSps);
    const subprofileIds = sps.map((sp) => sp.id);
    const itemsById = await this.loadItemsFor(subprofileIds);
    const socialLinksById = await this.loadSocialLinksFor(subprofileIds);
    const endorsementCountsById =
      await this.endorsementsService.loadEndorsementCountsFor(subprofileIds);
    const viewerEndorsedIds = await this.endorsementsService.viewerEndorsedFor(
      viewerId,
      subprofileIds,
    );
    const followerCountsById =
      await this.followersService.loadFollowerCountsFor(subprofileIds);
    const viewerFollowingIds = await this.followersService.viewerFollowingFor(
      viewerId,
      subprofileIds,
    );
    const affiliationsById = await this.resolveAffiliationsFor(
      viewerId,
      subprofileIds,
    );
    // Resolve ALL personas' item collaborator handles in ONE batched call,
    // shared by every mapper invocation below (no per-persona resolution).
    const collaboratorsByHandle = await this.resolveCollaboratorsFor(
      viewerId,
      [...itemsById.values()].flat(),
    );
    // One batched lookup for "is the viewer a co-owner of THIS persona?" —
    // avoids an N+1 members fetch per card.
    const viewerMemberRows = subprofileIds.length
      ? await this.members.find({
          where: { subprofileId: In(subprofileIds), userId: viewerId },
          select: { subprofileId: true },
        })
      : [];
    const viewerMemberIds = new Set(
      viewerMemberRows.map((row) => row.subprofileId),
    );
    const owner = {
      slug: profile.slug,
      name: `${profile.firstName} ${profile.lastName}`.trim(),
    };
    return sps.map((sp) =>
      toPublicDTO(
        sp,
        itemsById.get(sp.id) ?? [],
        owner,
        socialLinksById.get(sp.id) ?? [],
        endorsementCountsById.get(sp.id) ?? 0,
        viewerEndorsedIds.has(sp.id),
        followerCountsById.get(sp.id) ?? 0,
        viewerFollowingIds.has(sp.id),
        affiliationsById.get(sp.id) ?? [],
        collaboratorsByHandle,
        viewerMemberIds.has(sp.id),
      ),
    );
  }

  // Unlinked + published persona reachable by its global handle. Owner-stripped.
  async getByHandle(
    handle: string,
    viewerId: string,
  ): Promise<SubprofilePublicView> {
    const sp = await this.subprofiles.findOne({
      where: {
        handle,
        linkVisibility: SubprofileLinkVisibility.Unlinked,
        status: SubprofileStatus.Published,
        // Only Open personas are publicly reachable — `network`/`private` are
        // never served here (404, not a distinct "restricted" signal), matching
        // `directory` / `listPublicHandles`.
        visibility: SubprofileVisibility.Open,
      },
    });
    if (!sp) {
      throw new NotFoundException('Subprofile not found');
    }
    // A moderator takedown (hidden OR removed) withholds the persona as a 404 —
    // the withhold-entirely behaviour the directory/search reads share.
    const moderation = await this.contentModeration.stateFor(
      SubprofilesService.SUBJECT_TYPE,
      sp.slug,
    );
    if (moderation.hidden || moderation.removed) {
      throw new NotFoundException('Subprofile not found');
    }
    // Never surface the persona of someone the viewer has blocked (either way).
    if (await this.blockFilter.isBlockedEitherWay(viewerId, sp.userId)) {
      throw new NotFoundException('Subprofile not found');
    }
    const items = await this.items.find({ where: { subprofileId: sp.id } });
    const socialLinkRows = await this.socialLinks.find({
      where: { subprofileId: sp.id },
      order: { position: 'ASC' },
    });
    const endorsementCount =
      (await this.endorsementsService.loadEndorsementCountsFor([sp.id])).get(
        sp.id,
      ) ?? 0;
    const viewerEndorsed = (
      await this.endorsementsService.viewerEndorsedFor(viewerId, [sp.id])
    ).has(sp.id);
    const followerCount =
      (await this.followersService.loadFollowerCountsFor([sp.id])).get(sp.id) ??
      0;
    const viewerFollowing = (
      await this.followersService.viewerFollowingFor(viewerId, [sp.id])
    ).has(sp.id);
    const affiliations =
      (await this.resolveAffiliationsFor(viewerId, [sp.id])).get(sp.id) ?? [];
    const collaboratorsByHandle = await this.resolveCollaboratorsFor(
      viewerId,
      items,
    );
    const viewerIsMember =
      (await this.members.count({
        where: { subprofileId: sp.id, userId: viewerId },
      })) > 0;
    // no owner → owner fields omitted
    return toPublicDTO(
      sp,
      items,
      undefined,
      socialLinkRows,
      endorsementCount,
      viewerEndorsed,
      followerCount,
      viewerFollowing,
      affiliations,
      collaboratorsByHandle,
      viewerIsMember,
    );
  }

  // Directory of standalone (unlinked + published + open) personas.
  async directory(
    query: ListDirectoryQuery,
    viewerId: string,
  ): Promise<{ items: SubprofileCardView[] }> {
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
      .andWhere('sp.handle IS NOT NULL');

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
      qb.andWhere('(sp.displayName ILIKE :term OR sp.tagline ILIKE :term)', {
        term,
      });
    }

    qb.orderBy('sp.displayName', 'ASC').take(DIRECTORY_RESULT_CAP);
    const rows = await qb.getMany();
    const socialCountsById = await this.loadSocialCountsFor(
      rows.map((row) => row.id),
    );
    const tagsById = await this.loadContentTagsFor(rows.map((row) => row.id));
    return {
      items: rows.map((row) =>
        toCardDTO(
          row,
          socialCountsById.get(row.id) ?? 0,
          tagsById.get(row.id) ?? [],
        ),
      ),
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

  // ---- endorsements ----------------------------------------------------------
  //
  // Endorsement behaviour lives in `SubprofileEndorsementsService`; these stay
  // on the facade so controllers/other modules keep an unchanged public API.

  endorse(
    endorserId: string,
    id: string,
    note?: string,
  ): Promise<{ endorsementCount: number; viewerEndorsed: boolean }> {
    return this.endorsementsService.endorse(endorserId, id, note);
  }

  withdrawEndorsement(
    endorserId: string,
    id: string,
  ): Promise<{ endorsementCount: number; viewerEndorsed: boolean }> {
    return this.endorsementsService.withdrawEndorsement(endorserId, id);
  }

  listEndorsers(
    viewerId: string,
    id: string,
  ): Promise<{ count: number; endorsers: EndorserView[] }> {
    return this.endorsementsService.listEndorsers(viewerId, id);
  }

  // ---- followers -------------------------------------------------------------
  //
  // Follower behaviour lives in `SubprofileFollowersService`; these stay on the
  // facade so controllers/other modules keep an unchanged public API.

  follow(
    followerId: string,
    id: string,
  ): Promise<{ followerCount: number; viewerFollowing: boolean }> {
    return this.followersService.follow(followerId, id);
  }

  unfollow(
    followerId: string,
    id: string,
  ): Promise<{ followerCount: number; viewerFollowing: boolean }> {
    return this.followersService.unfollow(followerId, id);
  }

  // ---- internals -----------------------------------------------------------

  // Batches the resolved event/community links for many personas into TWO
  // entity queries total (one `events.find`, one `communities.find`), never
  // per-affiliation-row or per-persona — mirrors `loadSocialCountsFor` /
  // `loadContentTagsFor`. A target is DROPPED (not surfaced) from the result
  // if it no longer exists, is no longer publicly visible, or its owner is
  // block-filtered against `viewerId` — the read-side mirror of the
  // existence/visibility/block checks `replaceAffiliations` applies at save
  // time, so a target that goes private/gets deleted/becomes blocked after
  // linking silently disappears rather than 500ing or leaking it.
  private async resolveAffiliationsFor(
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
      ownerId: string;
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
      ...new Set([
        ...[...eventBySlug.values()].map((target) => target.ownerId),
        ...[...communityBySlug.values()].map((target) => target.ownerId),
      ]),
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
      if (!target || blockedOwnerIds.has(target.ownerId)) {
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
  private async resolveHandles(
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
          avatarUrl: toImageUrl(profile.avatarUrl),
          slug: profile.slug,
        });
      } else if (
        handleRow.ownerKind === HandleOwnerKind.Subprofile &&
        handleRow.subprofileId
      ) {
        const persona = subprofileById.get(handleRow.subprofileId);
        // Creditable ONLY when published + unlinked + not private: a linked
        // persona is nested under its owner (not creditable — see the phase
        // note), a draft doesn't exist publicly yet, and a private persona
        // isn't meant to be namelinked from someone else's page.
        if (
          !persona ||
          persona.status !== SubprofileStatus.Published ||
          persona.linkVisibility !== SubprofileLinkVisibility.Unlinked ||
          persona.visibility === SubprofileVisibility.Private ||
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
  private async resolveCollaboratorsFor(
    viewerId: string,
    items: SubprofileItem[],
  ): Promise<Map<string, CollaboratorView>> {
    const handleNames = items.flatMap((item) => item.collaborators ?? []);
    return this.resolveHandles(handleNames, viewerId);
  }

  private async ownerDTO(sp: Subprofile): Promise<SubprofileView> {
    const items = await this.items.find({ where: { subprofileId: sp.id } });
    const socialLinkRows = await this.socialLinks.find({
      where: { subprofileId: sp.id },
      order: { position: 'ASC' },
    });
    const endorsementCount =
      (await this.endorsementsService.loadEndorsementCountsFor([sp.id])).get(
        sp.id,
      ) ?? 0;
    const followerCount =
      (await this.followersService.loadFollowerCountsFor([sp.id])).get(sp.id) ??
      0;
    // Owner viewing their own persona: block-filter against the OWNER's own
    // user id (mirrors the design plan's `viewerId` param — here the "viewer"
    // is the owner). Consistent with the read paths below: a target that
    // becomes blocked/invisible after linking drops out for the owner too.
    const affiliations =
      (await this.resolveAffiliationsFor(sp.userId, [sp.id])).get(sp.id) ?? [];
    // Owner viewing their own persona: same "viewer = owner" convention as
    // `resolveAffiliationsFor` above.
    const collaboratorsByHandle = await this.resolveCollaboratorsFor(
      sp.userId,
      items,
    );
    return toSubprofileDTO(
      sp,
      items,
      socialLinkRows,
      endorsementCount,
      followerCount,
      affiliations,
      collaboratorsByHandle,
    );
  }

  private async loadItemsFor(
    ids: string[],
  ): Promise<Map<string, SubprofileItem[]>> {
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
  private async loadSocialLinksFor(
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
    const rows = await this.socialLinks.find({
      where: { subprofileId: In(subprofileIds) },
      select: { subprofileId: true },
    });
    for (const row of rows) {
      socialCountsBySubprofileId.set(
        row.subprofileId,
        (socialCountsBySubprofileId.get(row.subprofileId) ?? 0) + 1,
      );
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

  private async generateSlug(
    userId: string,
    displayName: string,
  ): Promise<string> {
    const base = slugifyDisplayName(displayName);
    const existing = await this.subprofiles.find({
      where: { userId },
      select: { slug: true },
    });
    const taken = new Set(existing.map((e) => e.slug));
    if (!taken.has(base)) {
      return base;
    }
    let n = 2;
    while (taken.has(`${base}-${n}`)) {
      n += 1;
    }
    return `${base}-${n}`;
  }

  private async saveSubprofile(sp: Subprofile): Promise<void> {
    try {
      await this.subprofiles.save(sp);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Duplicate slug (per owner) or handle (global) — surface as 409 so the
        // client re-picks (design spec §7).
        throw new ConflictException('slug or handle already in use');
      }
      throw err;
    }
  }
}
