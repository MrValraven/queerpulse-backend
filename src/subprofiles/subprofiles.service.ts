import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isUniqueViolation } from '../common/db-errors';
import { textHasBlockedTerm } from '../common/blocked-terms';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { normalizeHandle } from '../common/handles';
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
import { HandlesService } from '../handles/handles.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { BlockFilterService } from '../social/block-filter.service';
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
  type GigState,
  type ItemStructured,
  type WorkState,
} from './entities/subprofile-item.entity';
import { SubprofileItemRevision } from './entities/subprofile-item-revision.entity';
import {
  ItemRevisionDetail,
  ItemRevisionSummary,
  toRevisionDetail,
  toRevisionSummary,
} from './dto/item-revision.response';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { SubprofileSocialLink } from './entities/subprofile-social-link.entity';
import { SubprofileCreditsService } from './subprofile-credits.service';
import { SubprofileEndorsementsService } from './subprofile-endorsements.service';
import { SubprofileFollowersService } from './subprofile-followers.service';
import { SubprofileMembershipService } from './subprofile-membership.service';
import { SubprofilePublicReadService } from './subprofile-public-read.service';
import { isSectionAllowed } from './subprofile-kinds';
import {
  ACCENT_KEYS,
  AVAILABILITY_KEYS,
  isValidAffiliation,
  MAX_AFFILIATIONS,
  MAX_COLLABORATORS_PER_ITEM,
  MAX_GALLERY_PHOTOS,
  MAX_ITEMS_PER_SECTION,
  MAX_SUBPROFILES,
  slugifyDisplayName,
  validatePublish,
  validateSocialLinks,
} from './subprofile-validation';
import {
  EndorserView,
  FollowerView,
  imageKeysFor,
  SubprofileCardView,
  SubprofilePublicView,
  SubprofileSearchRow,
  SubprofileView,
  toSubprofileDTO,
} from './subprofile-response';
import { MemberView } from './subprofile-invite-response';
import {
  SUBPROFILE_DELETED,
  SubprofileDeletedEvent,
} from './subprofile.events';

// Hard cap on the serialized size of an owner-supplied jsonb payload
// (`structured` per item, `skinData` on the persona) — Personas redesign
// Phase 0. These two columns are schema-less past the DTO's `@IsObject()`
// shape check, so a size ceiling must exist before they can be persisted
// (design plan Task 6 Step 3).
const MAX_JSONB_BYTES = 16 * 1024;

// Protect Your Work (revision history): the maximum number of
// `subprofile_item_revisions` rows kept per item. `recordItemRevision` prunes
// the oldest rows past this cap every time it writes a new one.
const REVISION_CAP = 30;

// The user-authored content of a `SubprofileItem` row: every column except
// the identity/bookkeeping ones (`id`, `subprofileId`, `position`,
// `createdAt`) that describe WHERE or WHEN the row lives rather than WHAT it
// says. `section` is intentionally included: it is content-shaping (the
// section a revision belongs to matters for restore), unlike the excluded
// four.
export interface EditableItemContent {
  section: SubprofileSection;
  title: string;
  subtitle: string | null;
  description: string | null;
  url: string | null;
  imageUrl: string | null;
  date: string | null;
  meta: string | null;
  tags: string[];
  collaborators: string[];
  isFeatured: boolean;
  venue: string | null;
  doors: string | null;
  ticketUrl: string | null;
  gigState: GigState | null;
  medium: string | null;
  dimensions: string | null;
  edition: string | null;
  workState: WorkState | null;
  structured: ItemStructured | null;
}

// Protect Your Work (revision history), Task 7: the editable-content
// projection of a `SubprofileItem` row, used both to detect whether a save
// actually changed anything worth snapshotting and as the `snapshot` payload
// written to `subprofile_item_revisions`. Builds a NEW object with a fixed
// key order (rather than spreading `...rest` off the input) on purpose: two
// inputs of different origin, a hydrated `SubprofileItem` entity vs. a
// plain field literal built from an incoming DTO, are not guaranteed to
// enumerate their own keys in the same order, and a naive equality check
// over the raw object would falsely report "changed" on a same-content row
// that merely serializes its keys differently. (`canonicalStringify` below
// closes the same gap one level deeper, inside nested jsonb.) Exported for
// Task 8 (restore), which reuses this same projection to diff/apply a
// stored revision's `snapshot` back onto the live item.
export function editableSnapshot(
  item: EditableItemContent,
): EditableItemContent {
  return {
    section: item.section,
    title: item.title,
    subtitle: item.subtitle,
    description: item.description,
    url: item.url,
    imageUrl: item.imageUrl,
    date: item.date,
    meta: item.meta,
    tags: item.tags,
    collaborators: item.collaborators,
    isFeatured: item.isFeatured,
    venue: item.venue,
    doors: item.doors,
    ticketUrl: item.ticketUrl,
    gigState: item.gigState,
    medium: item.medium,
    dimensions: item.dimensions,
    edition: item.edition,
    workState: item.workState,
    structured: item.structured,
  };
}

// Protect Your Work (revision history), Task 7: recursively rebuilds `value`
// with every plain object's own keys sorted (arrays keep their original
// order, since order is meaningful there, e.g. `structured.courses`).
// Postgres jsonb normalizes key order on write, so a `structured` column
// read back from the database can enumerate its keys in a different order
// than the client's own payload did for the exact same content. A raw
// `JSON.stringify` comparison is key-order sensitive and would treat that
// as a content change; canonicalizing both sides first removes the false
// positive. Exported for Task 8 (restore), which needs the same
// content-equality notion.
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const canonicalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      canonicalized[key] = canonicalize(record[key]);
    }
    return canonicalized;
  }
  return value;
}

// Protect Your Work (revision history), Task 7: `JSON.stringify` over the
// canonicalized (key-order independent) form of `value`. Use this, not raw
// `JSON.stringify`, for every old-vs-new editable-content equality check in
// this file.
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

@Injectable()
export class SubprofilesService {
  constructor(
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(SubprofileItem)
    private readonly items: Repository<SubprofileItem>,
    // Protect Your Work (revision history). `replaceSection`'s own writes go
    // through the transaction `manager` (like every other repository in this
    // transaction, see the class-level convention noted on `create()`), not
    // this repository directly; it exists for the plain (non-transactional)
    // reads Task 8's list/get/restore endpoints add.
    @InjectRepository(SubprofileItemRevision)
    private readonly itemRevisions: Repository<SubprofileItemRevision>,
    @InjectRepository(SubprofileSocialLink)
    private readonly socialLinks: Repository<SubprofileSocialLink>,
    @InjectRepository(SubprofileMember)
    private readonly members: Repository<SubprofileMember>,
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly dataSource: DataSource,
    private readonly blockFilter: BlockFilterService,
    private readonly handles: HandlesService,
    private readonly endorsementsService: SubprofileEndorsementsService,
    private readonly followersService: SubprofileFollowersService,
    // Co-ownership membership gate + roster reads/mutations (extracted).
    private readonly membership: SubprofileMembershipService,
    // Collaboration-credit diff + notification fan-out for `replaceSection`
    // (extracted).
    private readonly credits: SubprofileCreditsService,
    // Public/card read surface + shared batched resolvers (extracted).
    private readonly publicRead: SubprofilePublicReadService,
    // Batched crop lookup for `avatarUrl`/`coverUrl`/item `imageUrl` — see
    // `MediaCropService.getMany` and `../media-crops/crop-response.ts`.
    private readonly mediaCropService: MediaCropService,
    // Emits `subprofile.deleted` so co-owners are notified when a creator
    // deletes a persona they share (Task 4). Globally available via
    // `EventEmitterModule` at the app root.
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // Public-to-private ordering of `SubprofileVisibility` — a higher rank is
  // MORE restrictive. A "downgrade" makes the persona less visible (a larger
  // rank), which only the creator may do (Task 4).
  private static readonly VISIBILITY_RANK: Record<
    SubprofileVisibility,
    number
  > = {
    [SubprofileVisibility.Open]: 0,
    [SubprofileVisibility.Network]: 1,
    [SubprofileVisibility.Private]: 2,
  };

  // Rejects an owner-supplied jsonb payload (`structured`/`skinData`) whose
  // serialized size exceeds `MAX_JSONB_BYTES`. `undefined`/`null` are
  // "nothing to persist" and always pass. Checked before either write path
  // touches the database, so an oversized payload never reaches a save.
  private assertJsonbSize(value: unknown, label: string): void {
    if (value === undefined || value === null) {
      return;
    }
    const serialized = JSON.stringify(value);
    if (
      serialized !== undefined &&
      Buffer.byteLength(serialized, 'utf8') > MAX_JSONB_BYTES
    ) {
      throw new BadRequestException(
        `${label} must be at most ${MAX_JSONB_BYTES / 1024} KB`,
      );
    }
  }

  // Protect Your Work (revision history), Task 7: snapshots `existingRow`'s
  // CURRENT (pre-save) editable content into `subprofile_item_revisions`,
  // then prunes that item's revisions down to `REVISION_CAP`, oldest first.
  // Takes the transaction `manager` (never `this.itemRevisions`) so this
  // write is part of the caller's transaction: a failed `replaceSection`
  // rolls the revision insert back too, and no revision is ever recorded
  // for a save that didn't actually commit.
  private async recordItemRevision(
    manager: EntityManager,
    existingRow: SubprofileItem,
  ): Promise<void> {
    const revision = manager.create(SubprofileItemRevision, {
      itemId: existingRow.id,
      subprofileId: existingRow.subprofileId,
      section: existingRow.section,
      // `snapshot` is `Record<string, unknown>` (Task 6); `EditableItemContent`
      // is a closed, concretely-typed shape with no index signature, so it is
      // not directly assignable without going through `unknown` first.
      snapshot: editableSnapshot(existingRow) as unknown as Record<
        string,
        unknown
      >,
    });
    await manager.save(revision);

    const revisionsForItem = await manager.find(SubprofileItemRevision, {
      where: { itemId: existingRow.id },
      order: { createdAt: 'ASC' },
    });
    if (revisionsForItem.length > REVISION_CAP) {
      await manager.remove(
        revisionsForItem.slice(0, revisionsForItem.length - REVISION_CAP),
      );
    }
  }

  // Protect Your Work (revision history), Task 8: list an item's saved
  // revisions, newest first. Reuses `getOwned` (delegates to
  // `SubprofileMembershipService.getOwned`): the SAME 404/403 owner/co-owner
  // gate `replaceSection`, `update`, `publish`, etc. already use, so restore
  // permissions match the rest of the item-editing surface.
  async listRevisions(
    userId: string,
    subprofileId: string,
    itemId: string,
  ): Promise<ItemRevisionSummary[]> {
    await this.getOwned(userId, subprofileId);
    const revisions = await this.itemRevisions.find({
      where: { itemId, subprofileId },
      order: { createdAt: 'DESC' },
    });
    return revisions.map(toRevisionSummary);
  }

  // Protect Your Work (revision history), Task 8: fetch one revision's full
  // snapshot. 404s both when the id is unknown and when it belongs to a
  // different item/subprofile: the `where` clause scopes the lookup so a
  // caller can never fetch a revision through the wrong item/subprofile pair.
  async getRevision(
    userId: string,
    subprofileId: string,
    itemId: string,
    revisionId: string,
  ): Promise<ItemRevisionDetail> {
    await this.getOwned(userId, subprofileId);
    const revision = await this.itemRevisions.findOne({
      where: { id: revisionId, itemId, subprofileId },
    });
    if (!revision) {
      throw new NotFoundException('Revision not found');
    }
    return toRevisionDetail(revision);
  }

  // Protect Your Work (revision history), Task 8: restores a stored
  // revision's editable content onto the live item. Non-destructive: before
  // the item is overwritten, its CURRENT editable content is snapshotted
  // into a fresh revision via `recordItemRevision` (the same helper
  // `replaceSection` uses), so the version being replaced is never lost:
  // restoring twice in a row is just two more revisions in the list, not
  // data loss. Both writes happen inside one transaction, so a failure
  // partway through never leaves the pre-restore snapshot without its
  // matching item overwrite (or vice versa).
  async restoreRevision(
    userId: string,
    subprofileId: string,
    itemId: string,
    revisionId: string,
  ): Promise<void> {
    await this.getOwned(userId, subprofileId);
    await this.dataSource.transaction(async (manager) => {
      const item = await manager.findOne(SubprofileItem, {
        where: { id: itemId, subprofileId },
      });
      if (!item) {
        throw new NotFoundException('Item not found');
      }
      const revision = await manager.findOne(SubprofileItemRevision, {
        where: { id: revisionId, itemId, subprofileId },
      });
      if (!revision) {
        throw new NotFoundException('Revision not found');
      }
      // Snapshot the item's CURRENT (pre-restore) content first.
      await this.recordItemRevision(manager, item);
      // Apply ONLY the editable fields from the stored snapshot.
      // `editableSnapshot` is the allowlist: it never reads or writes
      // `id`/`subprofileId`/`position`/`createdAt`, so those identity and
      // bookkeeping columns on `item` are left untouched by the restore.
      Object.assign(
        item,
        editableSnapshot(revision.snapshot as unknown as EditableItemContent),
      );
      await manager.save(item);
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
    const itemsById = await this.publicRead.loadItemsFor(subprofileIds);
    const [
      socialLinksById,
      endorsementCountsById,
      // Co-owner headcount for every persona in the list, in ONE grouped query
      // (Personas redesign Phase 2 dashboard plan Decision §5) — NOT a per-row
      // query per persona.
      memberCountsById,
      // Real follower counts + resolved affiliations for the owner dashboard —
      // previously hard-coded to `0` / `[]`, so the owner's own persona list
      // never showed its follower total or its event/community links. Owner is
      // the viewer here, mirroring `ownerDTO`.
      followerCountsById,
      affiliationsById,
    ] = await Promise.all([
      this.publicRead.loadSocialLinksFor(subprofileIds),
      this.endorsementsService.loadEndorsementCountsFor(subprofileIds),
      this.membership.loadMemberCountsFor(subprofileIds),
      this.followersService.loadFollowerCountsFor(subprofileIds),
      this.publicRead.resolveAffiliationsFor(userId, subprofileIds),
    ]);
    // Owner viewing their own personas: resolve ALL items' collaborator
    // handles across every subprofile in ONE batched call, shared by every
    // mapper invocation below (no per-persona resolution).
    const collaboratorsByHandle = await this.publicRead.resolveCollaboratorsFor(
      userId,
      [...itemsById.values()].flat(),
    );
    // ONE batched crop lookup for every persona's avatar/cover + every item
    // image in the whole list — never a per-persona/per-item query.
    const crops = await this.mediaCropService.getMany(
      sps.flatMap((sp) => imageKeysFor(sp, itemsById.get(sp.id) ?? [])),
    );
    return sps.map((sp) =>
      toSubprofileDTO(
        sp,
        itemsById.get(sp.id) ?? [],
        socialLinksById.get(sp.id) ?? [],
        endorsementCountsById.get(sp.id) ?? 0,
        followerCountsById.get(sp.id) ?? 0,
        affiliationsById.get(sp.id) ?? [],
        collaboratorsByHandle,
        memberCountsById.get(sp.id) ?? 1,
        crops,
      ),
    );
  }

  // Membership gate (404/403) backing every owner-facing write path. Behaviour
  // lives in `SubprofileMembershipService`; kept on the facade so the kept
  // core mutations (and the spec) keep calling `this.getOwned(...)` unchanged.
  getOwned(userId: string, id: string): Promise<Subprofile> {
    return this.membership.getOwned(userId, id);
  }

  // Public membership gate for other services (e.g. `SubprofileInvitesService`)
  // — delegates to the extracted membership service.
  assertMember(userId: string, subprofileId: string): Promise<Subprofile> {
    return this.membership.assertMember(userId, subprofileId);
  }

  async getOwnedDTO(userId: string, id: string): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);
    return this.ownerDTO(sp);
  }

  // List a persona's co-owners (members-gated). Delegates to the extracted
  // membership service.
  listMembers(userId: string, id: string): Promise<MemberView[]> {
    return this.membership.listMembers(userId, id);
  }

  // A co-owner leaves the persona. Delegates to the extracted membership
  // service (last-owner guard + persona-row lock live there).
  leave(userId: string, id: string): Promise<void> {
    return this.membership.leave(userId, id);
  }

  // ---- owner mutations -----------------------------------------------------

  async create(
    userId: string,
    dto: CreateSubprofileDTO,
  ): Promise<SubprofileView> {
    const slug = await this.generateSlug(userId, dto.displayName);
    const sp = this.subprofiles.create({
      userId,
      kind: dto.kind,
      displayName: dto.displayName,
      slug,
    });
    // The count-then-insert cap check is wrapped in ONE transaction guarded by
    // a per-user advisory lock — without it two concurrent creates could both
    // read `count === MAX_SUBPROFILES - 1` and both insert, pushing the user
    // one persona over their cap. There is no existing persona row to take a
    // `SELECT ... FOR UPDATE` on (the invite/accept/leave discipline locks the
    // persona being mutated; a create has none yet), so a transaction-scoped
    // `pg_advisory_xact_lock` keyed on the user serializes same-user creates
    // instead. The lock auto-releases at commit/rollback.
    //
    // The creator is always the persona's first member, so `getOwned`'s
    // membership check passes for them immediately. Saved in the SAME
    // transaction as the subprofile itself — a crash between the two writes
    // would otherwise leave a subprofile with no membership row, which then
    // 403s its own creator via `getOwned`'s membership gate.
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `subprofile_create:${userId}`,
        ]);
        const count = await manager.count(Subprofile, { where: { userId } });
        if (count >= MAX_SUBPROFILES) {
          throw new BadRequestException(
            `You can have at most ${MAX_SUBPROFILES} subprofiles`,
          );
        }
        await manager.save(sp);
        await manager.save(
          this.members.create({ subprofileId: sp.id, userId }),
        );
      });
    } catch (err) {
      // A cap breach is a client error, not a unique-violation — surface it
      // unchanged rather than translating it to a 409.
      if (err instanceof BadRequestException) {
        throw err;
      }
      // Mirrors `saveSubprofile`'s translation; the write is inlined here
      // (rather than delegating to `saveSubprofile`) because it must share ONE
      // transaction with the membership insert above.
      this.throwConflictOnUniqueViolation(err);
    }
    // The creator is the persona's only member the instant it's created (see
    // the transaction just above) — memberCount is 1, no query needed.
    return toSubprofileDTO(sp, [], [], 0, 0, [], new Map(), 1);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateSubprofileDTO,
  ): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);
    const prevLink = sp.linkVisibility;
    const prevHandle = sp.handle;
    // Creator vs. non-creator co-owner (Task 4): the creator is the persona's
    // original owner (`subprofiles.userId`). Non-creators keep normal content
    // editing but are barred from the destructive ops gated below.
    const isCreator = sp.userId === userId;
    const prevVisibility = sp.visibility;
    const prevStatus = sp.status;
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
    this.assertJsonbSize(rest.skinData, 'skinData');

    // A slug is the persona's address — it can never be blank. Trim it and
    // reject an empty one up front rather than writing "" into the per-owner
    // unique index.
    if (rest.slug !== undefined) {
      const trimmedSlug = rest.slug.trim();
      if (trimmedSlug.length === 0) {
        throw new BadRequestException('slug cannot be empty');
      }
      rest.slug = trimmedSlug;
    }

    // "No handle" is NULL, never "". The handle unique index is PARTIAL
    // (`WHERE handle IS NOT NULL`), so NULL is exempt but an empty string is
    // indexed and must be globally unique — which means two of an owner's
    // personas both saving "" collide on the global namespace even though
    // neither actually claims a handle. Normalize a blank handle to NULL so the
    // DB only ever sees a real handle or NULL. (`delete` keeps the subsequent
    // `Object.assign` from overwriting the NULL we set here.)
    if (rest.handle !== undefined) {
      const trimmedHandle = rest.handle?.trim() ?? '';
      if (trimmedHandle.length === 0) {
        delete rest.handle;
        sp.handle = null;
      } else {
        rest.handle = trimmedHandle;
      }
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

    // --- Task 4: creator-only destructive ops ------------------------------
    // Non-creator co-owners keep normal content editing (bio/items/socials/
    // affiliations/avatar/cover/name/tagline) but cannot re-address, hide, or
    // unpublish the persona. Evaluated against the fully-merged state so a
    // change reached by ANY path (explicit field, or a linkVisibility side
    // effect that nulls the handle / drafts the status) is caught uniformly.
    if (!isCreator) {
      if ((sp.handle ?? null) !== (prevHandle ?? null)) {
        throw new ForbiddenException(
          'Only the persona creator can change its handle',
        );
      }
      if (
        SubprofilesService.VISIBILITY_RANK[sp.visibility] >
        SubprofilesService.VISIBILITY_RANK[prevVisibility]
      ) {
        throw new ForbiddenException(
          'Only the persona creator can reduce its visibility',
        );
      }
      if (
        prevStatus === SubprofileStatus.Published &&
        sp.status === SubprofileStatus.Draft
      ) {
        throw new ForbiddenException(
          'Only the persona creator can unpublish it',
        );
      }
    }

    // --- Task 5: re-screen a published persona's identity text on edit -----
    // `validatePublish`'s blocked-term screen only runs at publish; without
    // this, a member could publish clean text and then PATCH a slur into a
    // live persona's name/tagline/bio. Re-run the same word-boundary screen
    // whenever a published persona's screened fields are touched, and reject.
    if (
      prevStatus === SubprofileStatus.Published &&
      (dto.displayName !== undefined ||
        dto.bio !== undefined ||
        dto.tagline !== undefined) &&
      textHasBlockedTerm(sp.displayName, sp.bio, sp.tagline)
    ) {
      throw new BadRequestException(
        'This persona’s name, tagline, or bio contains a term that isn’t allowed.',
      );
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
        this.throwConflictOnUniqueViolation(err);
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
    // The universal `gallery` section is a photo strip, capped far tighter
    // than the generic per-section limit above — a save that would leave
    // more than MAX_GALLERY_PHOTOS items in `gallery` is rejected outright
    // (this endpoint replaces one section's items at a time, so `items` here
    // IS the full incoming gallery group whenever `sectionEnum` is gallery).
    if (
      sectionEnum === SubprofileSection.Gallery &&
      items.length > MAX_GALLERY_PHOTOS
    ) {
      throw new BadRequestException(
        `The gallery can have at most ${MAX_GALLERY_PHOTOS} photos`,
      );
    }
    // At most one featured item may arrive in a single section payload. Checked
    // up front (before the delete/insert) so a bad payload fails fast.
    const incomingFeaturedCount = items.filter((it) => it.isFeatured).length;
    if (incomingFeaturedCount > 1) {
      throw new BadRequestException('Only one item can be featured');
    }
    // Personas redesign Phase 0: bound each item's `structured` jsonb before
    // anything is written (design plan Task 6 Step 3).
    for (const it of items) {
      this.assertJsonbSize(it.structured, 'structured');
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
    const collaboratorsByHandle = await this.publicRead.resolveHandles(
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

    // `subprofile_credit` diff (Personas discovery Phase 5, Decision §3):
    // snapshot the PERSONA-WIDE resolved-member collaborator set BEFORE this
    // write, compare to the set AFTER, and only notify newly-present handles.
    // Behaviour lives in `SubprofileCreditsService` — `collaboratorsByHandle`
    // (this section's already-resolved incoming collaborators) is reused as the
    // AFTER set so no extra `resolveHandles` call is needed.
    const newlyCreditedHandles = await this.credits.computeNewlyCreditedHandles(
      id,
      sp.userId,
      sectionEnum,
      collaboratorsByHandle,
    );

    await this.dataSource.transaction(async (manager) => {
      // Protect Your Work (revision history), Task 7: this used to be an
      // unconditional `manager.delete(...)` of every row in the section
      // followed by inserting `items.length` brand-new rows. That is no
      // longer safe to do unconditionally: `subprofile_item_revisions.item_id`
      // (Task 6) is `ON DELETE CASCADE` against `subprofile_items.id`, so a
      // row's id must survive a save for the revisions attached to it to
      // survive the save too. Deleting-and-recreating every row would cascade
      // away a just-written revision within the SAME transaction (delete
      // fires after the insert) or reject the insert outright with a foreign
      // key violation (delete fires first, so the parent no longer exists).
      // There is no ordering that makes the old shape work. Existing rows are
      // now UPDATED in place (id preserved) instead; only a genuine count
      // shrink still deletes rows, and only for the rows that fall off the
      // end.
      //
      // The incoming DTO (`SubprofileItemInputDTO`) carries no `id`. This
      // section-replace endpoint has never round-tripped one (see
      // `SubprofileCreditsService`'s "no stable item ids across saves" note,
      // which is exactly this same property), so there is no stronger
      // identity to match incoming items against existing rows than pairing
      // them up by position. A same-length reorder is therefore
      // indistinguishable, slot by slot, from a same-length content edit,
      // which is why the pure-reorder check just below exists: it detects a
      // whole-section reorder (same multiset of content, different order)
      // up front and skips per-slot revisions entirely for it, rather than
      // recording a spurious "changed" revision at every slot the reorder
      // touched. Giving the client a real id to send is a frontend/DTO
      // contract change outside this task's scope.
      const existingRows = await manager.find(SubprofileItem, {
        where: { subprofileId: id, section: sectionEnum },
        order: { position: 'ASC' },
      });

      const candidateFieldsByIndex: Omit<SubprofileItem, 'id' | 'createdAt'>[] =
        items.map((it, index) => ({
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
          collaborators: normalizedCollaboratorsByItemIndex[index] ?? [],
          isFeatured:
            sectionEnum === SubprofileSection.Links
              ? false
              : (it.isFeatured ?? false),
          position: index,
          // Personas redesign Phase 0 skin fields (design plan "Shared Contract").
          venue: it.venue ?? null,
          doors: it.doors ?? null,
          ticketUrl: it.ticketUrl ?? null,
          gigState: (it.gigState as GigState | undefined) ?? null,
          medium: it.medium ?? null,
          dimensions: it.dimensions ?? null,
          edition: it.edition ?? null,
          workState: (it.workState as WorkState | undefined) ?? null,
          structured: it.structured ?? null,
        }));

      // Pure-reorder detection: compare the MULTISET of canonical editable
      // content (sorted, not position-paired) on both sides. Equal multisets
      // of equal length mean this save only shuffled existing items around,
      // with no content actually added, removed, or edited, so no per-slot
      // diff below is a real content change; all of them would otherwise
      // read as "changed" purely because a different existing item now sits
      // at that slot.
      const existingCanonical = existingRows
        .map((row) => canonicalStringify(editableSnapshot(row)))
        .sort();
      const incomingCanonical = candidateFieldsByIndex
        .map((fields) => canonicalStringify(editableSnapshot(fields)))
        .sort();
      const isPureReorder =
        existingCanonical.length === incomingCanonical.length &&
        existingCanonical.every(
          (value, index) => value === incomingCanonical[index],
        );

      const rowsToSave: SubprofileItem[] = [];
      for (const [index, fields] of candidateFieldsByIndex.entries()) {
        const existingRow = existingRows[index];
        if (!existingRow) {
          // Beyond the current row count for this section: a genuinely new
          // item, nothing to snapshot against.
          rowsToSave.push(manager.create(SubprofileItem, fields));
          continue;
        }

        // Diff BEFORE mutating `existingRow` below: `editableSnapshot` reads
        // straight off the still-untouched hydrated row, so this is its true
        // pre-save content. Skipped entirely on a pure reorder (see above).
        if (
          !isPureReorder &&
          canonicalStringify(editableSnapshot(existingRow)) !==
            canonicalStringify(editableSnapshot(fields))
        ) {
          await this.recordItemRevision(manager, existingRow);
        }
        // Update in place: keeps `id` and `createdAt`, so the row's revision
        // history (and any FK elsewhere keyed on this item id) survives the
        // save.
        rowsToSave.push(Object.assign(existingRow, fields));
      }

      // Rows left over past the incoming count are items the client actually
      // removed from the section. Deleting them is correct here (unlike the
      // matched rows above), and it cascades away their revision history too,
      // since there is no longer a live item to view or restore that history
      // against.
      const removedRows = existingRows.slice(candidateFieldsByIndex.length);
      if (removedRows.length) {
        await manager.remove(removedRows);
      }

      if (rowsToSave.length) {
        await manager.save(rowsToSave);
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

    if (newlyCreditedHandles.length) {
      // Best-effort, post-commit: the section save already succeeded, and a
      // notification failure must never roll it back or fail the request
      // (mirrors `ModerationService.notifyModerationOutcome`).
      try {
        await this.credits.emitSubprofileCreditNotifications(
          sp,
          id,
          newlyCreditedHandles,
          items,
          normalizedCollaboratorsByItemIndex,
        );
      } catch {
        // Intentionally ignored — the section save already committed.
      }
    }

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
      // Null while the community is temporarily ownerless (owner account
      // erased, pending mod-promotion/reassignment) — there's no owner user
      // left to block-check against, so it's simply skipped here.
      if (
        community.accessTier !== AccessTier.Private &&
        community.ownerId !== null
      ) {
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
          (community.ownerId !== null && blockedOwnerIds.has(community.ownerId))
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

    // Single-persona co-owner headcount, shared by both return paths below
    // (Personas redesign Phase 2 dashboard plan Decision §5).
    const memberCount =
      (await this.membership.loadMemberCountsFor([sp.id])).get(sp.id) ?? 1;
    // Shared by both return paths below, same reasoning as `memberCount`.
    const crops = await this.mediaCropService.getMany(imageKeysFor(sp, items));

    if (!unlinked) {
      // Linked personas render nested and never carry a global handle.
      sp.handle = null;
      sp.status = SubprofileStatus.Published;
      await this.saveSubprofile(sp);
      return toSubprofileDTO(
        sp,
        items,
        socialLinkRows,
        0,
        0,
        [],
        new Map(),
        memberCount,
        crops,
      );
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
    return toSubprofileDTO(
      sp,
      items,
      socialLinkRows,
      0,
      0,
      [],
      new Map(),
      memberCount,
      crops,
    );
  }

  async unpublish(userId: string, id: string): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);
    // Creator-only (Task 4): unpublishing is a destructive op — gated on the
    // dedicated route too, not just the `update` side effect, so a non-creator
    // co-owner cannot bypass the in-`update` unpublish gate via this method.
    if (sp.userId !== userId) {
      throw new ForbiddenException('Only the persona creator can unpublish it');
    }
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
    // Creator-only (Task 4): only the persona's original owner may delete it —
    // a non-creator co-owner leaves via `DELETE :id/members/me` instead.
    if (sp.userId !== userId) {
      throw new ForbiddenException('Only the persona creator can delete it');
    }
    // Capture the co-owner roster BEFORE the delete cascades away the
    // `subprofile_members` rows — the deletion notification fans out to every
    // co-owner except the creator who initiated it.
    const memberRows = await this.members.find({
      where: { subprofileId: id },
      select: { userId: true },
    });
    const coOwnerIds = memberRows
      .map((row) => row.userId)
      .filter((memberUserId) => memberUserId !== sp.userId);
    const displayName = sp.displayName;
    // `subprofile_items` AND the persona's `handles` registry row (if any) both
    // cascade via their FK's ON DELETE CASCADE on `subprofile_id` — deleting the
    // subprofile auto-frees its global handle, so no explicit release is needed.
    await this.subprofiles.remove(sp);
    // Emitted AFTER the row is gone — a listener must never observe a persona
    // that could still exist. Best-effort: the delete already committed, so a
    // notification failure must not surface as an error to the caller.
    if (coOwnerIds.length) {
      this.eventEmitter.emit(SUBPROFILE_DELETED, {
        subprofileId: id,
        displayName,
        deletedByUserId: userId,
        coOwnerIds,
      } satisfies SubprofileDeletedEvent);
    }
  }

  // Creator-initiated "remove a co-owner" (Task 4). Delegates to the extracted
  // membership service (creator-only gate + member-removed event live there).
  removeMember(
    creatorUserId: string,
    id: string,
    targetSlug: string,
  ): Promise<void> {
    return this.membership.removeMember(creatorUserId, id, targetSlug);
  }

  // ---- public reads --------------------------------------------------------

  // Linked + published personas nested under a member's main profile.
  // Delegates to the extracted public-read service.
  listForProfile(
    ownerSlug: string,
    viewerId: string,
  ): Promise<SubprofilePublicView[]> {
    return this.publicRead.listForProfile(ownerSlug, viewerId);
  }

  // Unlinked persona reachable by its global handle. Delegates to the extracted
  // public-read service (owner-stripping + Shared Contract gating live there).
  getByHandle(
    handle: string,
    viewer: CurrentUserData | undefined,
  ): Promise<SubprofilePublicView> {
    return this.publicRead.getByHandle(handle, viewer);
  }

  // Single linked + published persona nested under a member's profile, by its
  // per-owner slug. Delegates to the extracted public-read service.
  getBySlugForProfile(
    ownerSlug: string,
    subslug: string,
    viewer: CurrentUserData | undefined,
  ): Promise<SubprofilePublicView> {
    return this.publicRead.getBySlugForProfile(ownerSlug, subslug, viewer);
  }

  // Directory of standalone (unlinked + published + open) personas. Delegates
  // to the extracted public-read service.
  directory(
    query: ListDirectoryQuery,
    viewerId: string,
  ): Promise<{
    items: SubprofileCardView[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.publicRead.directory(query, viewerId);
  }

  // Cross-entity global search (SearchService) — standalone personas only.
  // Delegates to the extracted public-read service.
  searchByText(
    viewerId: string,
    term: string,
    limit: number,
  ): Promise<SubprofileSearchRow[]> {
    return this.publicRead.searchByText(viewerId, term, limit);
  }

  // Public, unauthenticated enumeration of every crawlable persona handle.
  // Delegates to the extracted public-read service.
  listPublicHandles(): Promise<{
    items: { handle: string; updatedAt: string }[];
  }> {
    return this.publicRead.listPublicHandles();
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
    page?: number,
    limit?: number,
  ): Promise<{ count: number; endorsers: EndorserView[] }> {
    return this.endorsementsService.listEndorsers(viewerId, id, page, limit);
  }

  getViewerEndorsement(
    viewerId: string,
    id: string,
  ): Promise<{ viewerEndorsed: boolean; note: string | null }> {
    return this.endorsementsService.getViewerEndorsement(viewerId, id);
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

  // Owner-only follower list — 403s every non-co-owner (see the service).
  listFollowers(
    viewerId: string,
    id: string,
    page?: number,
    limit?: number,
  ): Promise<{ count: number; followers: FollowerView[] }> {
    return this.followersService.listFollowers(viewerId, id, page, limit);
  }

  // ---- internals -----------------------------------------------------------

  private async ownerDTO(sp: Subprofile): Promise<SubprofileView> {
    // Owner viewing their own persona: block-filter against the OWNER's own
    // user id (mirrors the design plan's `viewerId` param — here the "viewer"
    // is the owner). Consistent with the read paths: a target that becomes
    // blocked/invisible after linking drops out for the owner too. These five
    // reads are mutually independent — batched into one round trip.
    const [
      items,
      socialLinkRows,
      endorsementCountsById,
      followerCountsById,
      affiliationsById,
      memberCountsById,
    ] = await Promise.all([
      this.items.find({ where: { subprofileId: sp.id } }),
      this.socialLinks.find({
        where: { subprofileId: sp.id },
        order: { position: 'ASC' },
      }),
      this.endorsementsService.loadEndorsementCountsFor([sp.id]),
      this.followersService.loadFollowerCountsFor([sp.id]),
      this.publicRead.resolveAffiliationsFor(sp.userId, [sp.id]),
      // Single-persona co-owner headcount — cheap enough to include on every
      // owner-facing read for consistency (Personas redesign Phase 2 dashboard
      // plan Decision §5).
      this.membership.loadMemberCountsFor([sp.id]),
    ]);
    const endorsementCount = endorsementCountsById.get(sp.id) ?? 0;
    const followerCount = followerCountsById.get(sp.id) ?? 0;
    const affiliations = affiliationsById.get(sp.id) ?? [];
    const memberCount = memberCountsById.get(sp.id) ?? 1;
    // Owner viewing their own persona: same "viewer = owner" convention as
    // `resolveAffiliationsFor` above. Depends on `items`, so it follows.
    const collaboratorsByHandle = await this.publicRead.resolveCollaboratorsFor(
      sp.userId,
      items,
    );
    const crops = await this.mediaCropService.getMany(imageKeysFor(sp, items));
    return toSubprofileDTO(
      sp,
      items,
      socialLinkRows,
      endorsementCount,
      followerCount,
      affiliations,
      collaboratorsByHandle,
      memberCount,
      crops,
    );
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
      this.throwConflictOnUniqueViolation(err);
    }
  }

  /**
   * Translate a Postgres unique violation into a 409 that names WHICH namespace
   * collided — the per-owner slug or the global handle — so the client can point
   * the user at the right field. Any non-unique-violation error is re-thrown
   * unchanged. Never returns (design spec §7: the client re-picks).
   */
  private throwConflictOnUniqueViolation(err: unknown): never {
    if (isUniqueViolation(err, 'UQ_subprofiles_user_slug')) {
      throw new ConflictException('slug already in use');
    }
    if (isUniqueViolation(err, 'UQ_subprofiles_handle')) {
      throw new ConflictException('handle already in use');
    }
    if (isUniqueViolation(err)) {
      throw new ConflictException('slug or handle already in use');
    }
    throw err;
  }
}
