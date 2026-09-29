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
import { DataSource, EntityManager, In, Not, Repository } from 'typeorm';
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
import { Handle, HandleOwnerKind } from '../handles/entities/handle.entity';
import { HandleOwner, HandlesService } from '../handles/handles.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { BlockFilterService } from '../social/block-filter.service';
import { storageKeyOwnerId } from '../storage/storage-key';
import { Profile } from '../users/entities/profile.entity';
import { CreateSubprofileDTO } from './dto/create-subprofile.dto';
import { ListSubprofileDirectoryQuery } from './dto/list-directory.query';
import { SubprofileItemInputDTO } from './dto/replace-items.dto';
import { UpdateSubprofileDTO } from './dto/update-subprofile.dto';
import { SubprofileAffiliation } from './entities/subprofile-affiliation.entity';
import { SubprofileAddressHistory } from './entities/subprofile-address-history.entity';
import { SubprofileEndorsement } from './entities/subprofile-endorsement.entity';
import { SubprofileFollower } from './entities/subprofile-follower.entity';
import {
  AffiliationOption,
  hasQualifyingOwner,
  SubprofileAffiliationEligibilityService,
} from './subprofile-affiliation-eligibility.service';
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
import { SubprofileUpdatesService } from './subprofile-updates.service';
import { SubprofileEndorsementsService } from './subprofile-endorsements.service';
import { SubprofileFollowersService } from './subprofile-followers.service';
import { SubprofileMembershipService } from './subprofile-membership.service';
import { SubprofilePublicReadService } from './subprofile-public-read.service';
import { isSectionAllowed } from './subprofile-kinds';
import {
  deriveLinkedPersonaHandle,
  handleIsKindName,
  handleNamesOwner,
} from './persona-handle';
import {
  ACCENT_KEYS,
  AVAILABILITY_KEYS,
  handleUnmetCodes,
  linkedHandleUnmetCodes,
  isValidAffiliation,
  MAX_AFFILIATIONS,
  MAX_COLLABORATORS_PER_ITEM,
  MAX_GALLERY_PHOTOS,
  MAX_ITEMS_PER_SECTION,
  MAX_SUBPROFILES,
  type PublishUnmetCode,
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
  sortByMemberPosition,
  toSubprofileDTO,
} from './subprofile-response';
import { Paginated } from '../common/pagination';
import { FollowedPersonaView } from './subprofile-following-response';
import { MemberView } from './subprofile-invite-response';
import {
  SUBPROFILE_DELETED,
  SubprofileDeletedEvent,
} from './subprofile.events';
import {
  SUBPROFILE_PUBLISHED,
  SubprofilePublishedEvent,
} from '../profiles/activity.listener';

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

/** Who is writing, re-checked against the locked persona row
 * (`SubprofilesService.lockCurrentSubprofile`). */
interface SubprofileLockChecks {
  /** The member making the edit: refused with the membership 403 when they
   * no longer hold a roster row (they left, or handed the persona over). */
  editorUserId: string;
  /** Set for an edit only the creator may make: refused unless this user is
   * still the creator on the locked row. */
  requiredCreatorUserId?: string;
  /** ENG-451: the `editVersion` an editor write was built on. When set and
   * the locked row holds another value, the write is refused with the 409
   * `PERSONA_EDIT_CONFLICT` before it changes anything. */
  expectedEditVersion?: number;
}

/** How `SubprofilesService.saveEditUnderLock` persists an edit. */
interface SubprofileEditSaveOptions extends SubprofileLockChecks {
  /** True when the edit itself sets a new `slug`; otherwise the committed
   * slug is kept, so a slug the creator transfer suffixed is never reverted. */
  hasEditedSlug: boolean;
  /** True when the edit itself sets `handle`: a typed or cleared handle, a
   * link switch, or a name the edit's transaction claimed or derived.
   * Otherwise the committed handle is kept, the way `slug` is, so an edit
   * that waited on a creator transfer never writes back the departed
   * creator's name the transfer re-issued (PRD-431). */
  hasEditedHandle: boolean;
  /** True when the edit itself switches `linkVisibility` (resending the
   * loaded value is no switch). Otherwise the committed link state is kept,
   * the way `slug` is, so a stale edit never flips it back. */
  hasEditedLinkVisibility: boolean;
  /** True when the edit changes `status` or `handle` (publish, unpublish, a
   * handle edit). Those were decided against the loaded link state, so the
   * save is refused with a 409 when that state moved meanwhile. */
  hasLinkDependentChange: boolean;
  /** The `linkVisibility` and `status` the edit was decided against. A link
   * switch whose locked row no longer matches them is refused with a 409. */
  loadedLinkVisibility: SubprofileLinkVisibility;
  loadedStatus: SubprofileStatus;
  /** True for the PATCH editor write (ENG-451): the save stores the locked
   * row's `editVersion` plus 1. Every other save keeps the committed value. */
  shouldAdvanceEditVersion?: boolean;
}

/** The typed code of the 409 an editor write gets when its
 * `expectedEditVersion` is stale. The frontend's `isPersonaEditConflict`
 * reads it off the body. */
const PERSONA_EDIT_CONFLICT_CODE = 'PERSONA_EDIT_CONFLICT';

/** The 409 an editor write (PATCH, section PUT, social-links PUT,
 * affiliations PUT, item revision restore) gets when someone else saved the
 * persona after this editor loaded it (ENG-451). `currentEditVersion` is the
 * stored value, so the client knows which version to reload. */
class PersonaEditConflictException extends ConflictException {
  constructor(currentEditVersion: number) {
    super({
      code: PERSONA_EDIT_CONFLICT_CODE,
      message:
        'Someone else saved this persona while you were editing. Reload it and try again.',
      currentEditVersion,
    });
  }
}

/** The 409 a write gets when the persona's link state, status or handle moved
 * between the unlocked load and the locked write. Its own class, so `publish`
 * can rethrow it apart from a handle-registry conflict. Publish, unpublish
 * and a creator transfer leave `edit_version` alone, so an editor can pass
 * the version check and still meet this. It carries the same
 * `PERSONA_EDIT_CONFLICT` code and the locked row's `currentEditVersion`, so
 * the editor offers its Reload alert for it too. */
class PersonaChangedMeanwhileException extends ConflictException {
  constructor(currentEditVersion: number) {
    super({
      code: PERSONA_EDIT_CONFLICT_CODE,
      message:
        'This persona changed while you were editing. Reload it and try again.',
      currentEditVersion,
    });
  }
}

/** How many times a server-derived handle claim may lose a race to another
 * writer before the write gives up: a publish, or an update that links a
 * published persona. Each attempt re-derives, so the next one skips the name
 * that was just taken. */
const MAX_DERIVED_HANDLE_CLAIM_ATTEMPTS = 5;

/** Raised inside a claim transaction when a server-derived handle was taken
 * between the availability check and the insert. It never leaves the service:
 * `retryLostDerivedHandleRace` catches it and runs the transaction again. */
class LostDerivedHandleRaceError extends Error {
  constructor() {
    super('A derived persona handle was claimed by another writer first.');
  }
}

/** The registry owner for a persona's handle. */
function subprofileHandleOwner(subprofileId: string): HandleOwner {
  return { kind: 'subprofile', subprofileId };
}

/** The checks publish runs on a handle, for a published persona renamed in
 * place (PRD-427). Linked: `linkedHandleUnmetCodes`. Unlinked: the three
 * namespace checks, then `handle_names_owner` (when the creator slug is
 * known) and `handle_is_kind`, as `validatePublish` orders them, plus the
 * blocked-term screen on the handle alone. The rest of the persona's text is
 * outside a handle change. */
function publishedHandleUnmetCodes(
  handle: string,
  handleTaken: boolean,
  persona: Subprofile,
  creatorSlug: string | null,
): PublishUnmetCode[] {
  if (persona.linkVisibility === SubprofileLinkVisibility.Linked) {
    return linkedHandleUnmetCodes(handle, handleTaken, persona.kind);
  }
  const unmet = handleUnmetCodes(handle, handleTaken);
  if (
    unmet.length === 0 &&
    creatorSlug &&
    handleNamesOwner(handle, creatorSlug)
  ) {
    unmet.push('handle_names_owner');
  }
  if (unmet.length === 0 && handleIsKindName(handle, persona.kind)) {
    unmet.push('handle_is_kind');
  }
  if (textHasBlockedTerm(handle)) {
    unmet.push('blocked_terms');
  }
  return unmet;
}

/** The 409 a published persona's handle rename gets when the typed name is
 * taken, whether the availability check or the registry claim found it
 * (PRD-427). */
function handleTakenOnRenameException(): ConflictException {
  return new ConflictException({
    code: 'HANDLE_TAKEN',
    message: 'That handle is already taken.',
    unmet: ['handle_taken'],
  });
}

/** The 422 a linked persona gets when its creator has no profile row, so no
 * `<creatorSlug>-<personaSlug>` handle can be built for it. */
function missingCreatorProfileException(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'SUBPROFILE_NOT_READY',
    message: 'This persona has no owner profile to build its address from.',
    unmet: ['handle_invalid'],
  });
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
    private readonly updates: SubprofileUpdatesService,
    // Public/card read surface + shared batched resolvers (extracted).
    private readonly publicRead: SubprofilePublicReadService,
    // "Part of" eligibility: the persona's owners must belong to a linked
    // community or be going to a linked event (`replaceAffiliations`,
    // `listAffiliationOptions`).
    private readonly affiliationEligibility: SubprofileAffiliationEligibilityService,
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
  //
  // A restore is a persona content write like the four editor writes
  // (ENG-451): it takes the persona row lock first, refuses a stale
  // `expectedEditVersion` with the 409 `PERSONA_EDIT_CONFLICT` before any
  // item row is touched, and raises `edit_version` by exactly 1. The locked
  // read also gives the 404 / membership 403 `getOwned` gives. Returns the
  // raised version, for the response.
  async restoreRevision(
    userId: string,
    subprofileId: string,
    itemId: string,
    revisionId: string,
    expectedEditVersion?: number,
  ): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const advancedEditVersion = await this.lockAndAdvanceEditVersion(
        manager,
        subprofileId,
        userId,
        expectedEditVersion,
      );
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
      return advancedEditVersion;
    });
  }

  // ---- owner reads ---------------------------------------------------------

  async listMine(userId: string): Promise<SubprofileView[]> {
    // Co-owner-aware: list every persona this member belongs to via
    // `subprofile_members`, not only ones they created (`sp.userId`). Mirrors
    // the `isMember` gate backing `getOwned`.
    //
    // `position` rides along on this SAME query (it is a column on the rows
    // already being fetched), so per-member ordering costs no extra round
    // trip.
    const memberRows = await this.members.find({
      where: { userId },
      select: { subprofileId: true, position: true },
    });
    const ids = memberRows.map((row) => row.subprofileId);
    const sps = ids.length
      ? await this.subprofiles.find({
          where: { id: In(ids) },
          order: { position: 'ASC', createdAt: 'ASC' },
        })
      : [];
    // The caller's OWN arrangement of their list (`subprofile_members.
    // position`), applied in memory over the rows above. The query's `ORDER
    // BY` is left alone deliberately: `subprofiles.position` is frozen
    // history now, and it only serves as a stable input that this sort then
    // overrides. A co-owned persona sits wherever THIS member put it, which
    // is what the shared `subprofiles.position` column could never express
    // (see migration `1817210000000-AddSubprofileMemberPosition`).
    const memberPositionsBySubprofileId = new Map(
      memberRows.map((row) => [row.subprofileId, row.position]),
    );
    const orderedSps = sortByMemberPosition(sps, memberPositionsBySubprofileId);
    const subprofileIds = orderedSps.map((sp) => sp.id);
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
      orderedSps.flatMap((sp) => imageKeysFor(sp, itemsById.get(sp.id) ?? [])),
    );
    return orderedSps.map((sp) =>
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
        // The caller's own rank for this persona, so the dashboard's
        // `position` agrees with the order the list came back in.
        memberPositionsBySubprofileId.get(sp.id),
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

  /**
   * Rewrite the order of the caller's OWN persona list, top first.
   *
   * The single writer of persona ordering. It writes
   * `subprofile_members.position`, never `subprofiles.position`: a co-owned
   * persona hangs under every co-owner's profile, so a shared column on the
   * persona row meant one co-owner arranging their page silently reshuffled
   * their collaborator's. Each membership row now carries that member's own
   * rank, and `position` is gone from `UpdateSubprofileDTO` so nothing else
   * can write ordering at all.
   *
   * `ids` MUST be a complete permutation of the caller's membership set, and
   * this is the same reasoning the section-replace path documents: this
   * endpoint's only identity for a row is its slot, so a list that names only
   * some of the personas leaves the rest ambiguous. Sending five ids for
   * eight personas leaves three with no defined slot, and accepting it would
   * mean inventing a rule (leave them where they were? push them to the end?)
   * that the client never stated and cannot see the result of before it
   * renders.
   * Length, duplicates and unknown ids are therefore each rejected outright
   * with a message naming what was wrong, so a client bug surfaces as a 400 it
   * can read instead of a list that quietly rearranged itself.
   *
   * Unknown ids are rejected rather than ignored for a second reason: an id
   * the caller does not belong to is either a stale client cache or a probe at
   * somebody else's persona. Neither should write anything, and neither should
   * be told whether the id exists, so the message names the caller's own list
   * rather than the id's status.
   *
   * A member who holds no personas sending `[]` is a valid no-op: an empty
   * list really is its own only permutation.
   */
  async reorderMine(userId: string, ids: string[]): Promise<void> {
    const memberRows = await this.members.find({
      where: { userId },
      select: { id: true, subprofileId: true },
    });

    if (ids.length !== memberRows.length) {
      throw new BadRequestException(
        `ids must list every one of your personas exactly once ` +
          `(expected ${memberRows.length}, received ${ids.length})`,
      );
    }

    // Duplicates are checked before membership so "you sent the same persona
    // twice" is never reported as the vaguer "one of these is not yours".
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) {
      throw new BadRequestException('ids must not contain duplicates');
    }

    const memberRowBySubprofileId = new Map(
      memberRows.map((row) => [row.subprofileId, row]),
    );
    for (const subprofileId of ids) {
      if (!memberRowBySubprofileId.has(subprofileId)) {
        throw new BadRequestException(
          'ids must list every one of your personas exactly once ' +
            'and nothing else',
        );
      }
    }

    // Nothing to write, and no transaction to open, for a member with no
    // personas. The three checks above have already established that `ids` is
    // empty too.
    if (memberRows.length === 0) {
      return;
    }

    // ONE transaction for the whole list. A reorder is a single act from the
    // member's side: a half-applied one would leave two personas sharing a
    // rank and the list settling somewhere neither the old order nor the new
    // one, which the reader's `createdAt` tiebreak would then make look
    // arbitrary rather than broken.
    //
    // The rows are addressed by their own primary key (resolved above), so
    // this never touches another member's row for the same persona.
    await this.dataSource.transaction(async (manager) => {
      for (const [index, subprofileId] of ids.entries()) {
        const memberRow = memberRowBySubprofileId.get(subprofileId)!;
        await manager.update(
          SubprofileMember,
          { id: memberRow.id },
          { position: index },
        );
      }
    });
  }

  async create(
    userId: string,
    dto: CreateSubprofileDTO,
  ): Promise<SubprofileView> {
    const slug = await this.generateSlug(userId, dto.displayName);
    // Set explicitly (it is also the column default) so the handle derivation
    // below reads the link state before the insert returns it.
    const sp = this.subprofiles.create({
      userId,
      kind: dto.kind,
      displayName: dto.displayName,
      slug,
      linkVisibility: SubprofileLinkVisibility.Linked,
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
        // A new persona is a linked draft, so it stores its `/p/<handle>`
        // from the start (see `deriveLinkedDraftHandle`). The row is not
        // inserted yet, so there is no own name or row to leave out.
        if (
          sp.linkVisibility === SubprofileLinkVisibility.Linked &&
          !sp.handle
        ) {
          sp.handle = await this.deriveLinkedDraftHandle(
            manager,
            undefined,
            userId,
            slug,
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

  /**
   * The co-owner half of the storage-key ownership rule.
   *
   * `StorageKeyOwnershipInterceptor` rejects a write body that names an upload
   * belonging to somebody else, in either the bare-key or the resolved
   * `/files/<key>` form — that is what stops a member attaching another
   * member's photo to their own entity. A persona is CO-OWNED, though, so its
   * edit form is seeded with an image a DIFFERENT collaborator may have
   * uploaded and re-sends it verbatim on save; a blanket rule would 403 that
   * no-op. So these two handlers are listed in `SHARED_UPLOAD_HANDLERS`, which
   * hands the decision here: a foreign upload is allowed ONLY when it is
   * ALREADY the stored value (nothing changed). A foreign upload the persona
   * does not already carry is a new reference and is refused, exactly as the
   * interceptor would have.
   */
  private assertNoForeignUploadIntroduced(
    requesterUserId: string,
    incoming: string | null | undefined,
    alreadyStored: readonly (string | null | undefined)[],
  ): void {
    if (!incoming) {
      return;
    }
    // The interceptor already collapsed any `/files/<key>` URL to its bare key
    // before this ran, so both sides of the comparison are canonical keys.
    const ownerUserId = storageKeyOwnerId(incoming);
    if (ownerUserId === null || ownerUserId === requesterUserId) {
      return;
    }
    if (alreadyStored.includes(incoming)) {
      return;
    }
    // Same wording as the interceptor's, and deliberately free of the owner's
    // id — a 403 must not confirm who uploaded a key.
    throw new ForbiddenException('Referenced upload does not belong to you');
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateSubprofileDTO,
  ): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);
    // Runs BEFORE any mutation: a collaborator may re-save the persona's
    // existing avatar/cover whoever uploaded it, but may not point either
    // field at a new upload that is not theirs.
    this.assertNoForeignUploadIntroduced(userId, dto.avatarUrl, [sp.avatarUrl]);
    this.assertNoForeignUploadIntroduced(userId, dto.coverUrl, [sp.coverUrl]);
    const prevLink = sp.linkVisibility;
    const prevHandle = sp.handle;
    const prevSlug = sp.slug;
    // Creator vs. non-creator co-owner (Task 4): the creator is the persona's
    // original owner (`subprofiles.userId`). Non-creators keep normal content
    // editing but are barred from the destructive ops gated below.
    const isCreator = sp.userId === userId;
    const prevVisibility = sp.visibility;
    const prevStatus = sp.status;
    // `expectedEditVersion` is the ENG-451 save precondition, checked under
    // the row lock by `lockCurrentSubprofile`. It is request-only, so it is
    // kept out of `rest` and never assigned onto the entity.
    const { linkVisibility, expectedEditVersion, ...rest } = dto;

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

    // Set when a PUBLISHED persona is linked: it stays published, so it must
    // hold a handle the moment the edit commits. The claim runs in the same
    // transaction as the link switch's release.
    let shouldClaimLinkedHandleNow = false;
    // Set when the handle of a PUBLISHED persona changes with no link switch
    // (PRD-427): it stays published, so the new name is validated and claimed,
    // and the old one released with forwarding, in the edit's transaction.
    let shouldRenamePublishedHandle = false;
    // Set when a linked persona goes unlinked (ENG-447): the clean break that
    // deletes its followers, endorsements and old nested addresses runs in the
    // edit's transaction.
    const isUnlinkingSwitch =
      !!linkVisibility &&
      prevLink === SubprofileLinkVisibility.Linked &&
      linkVisibility === SubprofileLinkVisibility.Unlinked;

    if (linkVisibility && linkVisibility !== prevLink) {
      sp.linkVisibility = linkVisibility;
      // Either direction frees the name a published persona holds (released
      // in the transaction below, read off the locked row), and drops it
      // from the row unless this same edit typed a new one.
      const hasTypedNewHandle = !!sp.handle && sp.handle !== prevHandle;
      if (!hasTypedNewHandle) {
        sp.handle = null;
      }
      if (linkVisibility === SubprofileLinkVisibility.Linked) {
        // unlinked to linked: a published persona claims its new handle (the
        // typed one, or `<creatorSlug>-<personaSlug>`) right away. A draft
        // stores the typed one, or has `<creatorSlug>-<personaSlug>` stored
        // for it below, with no registry claim until publish.
        shouldClaimLinkedHandleNow = prevStatus === SubprofileStatus.Published;
      } else {
        // linked to unlinked: must re-pass the completeness check, with a
        // handle that does not name the creator, before it can (re)publish
        // and claim one. Leave it unpublished until then.
        sp.status = SubprofileStatus.Draft;
      }
    } else if (
      prevStatus === SubprofileStatus.Published &&
      (sp.handle ?? null) !== (prevHandle ?? null)
    ) {
      // PRD-427: changing the `handle` of a published persona, of either link
      // kind, keeps it PUBLISHED. In the edit's transaction the new name is
      // validated with the checks publish runs on a handle, claimed, and the
      // old one released WITH forwarding, so `PERSONA_MOVED` sends old links
      // to the new address during the cooldown and the page never goes
      // offline (`renamePublishedHandle`). A published persona with no stored
      // handle (a linked row the backfill skipped) claims the typed one the
      // same way, with nothing to release. A linked persona whose handle is
      // cleared claims its derived default.
      shouldRenamePublishedHandle = true;
    }

    // --- Task 4: creator-only destructive ops ------------------------------
    // Non-creator co-owners keep normal content editing (bio/items/socials/
    // affiliations/avatar/cover/name/tagline) but cannot re-address, hide, or
    // unpublish the persona. Evaluated against the fully-merged state so a
    // change reached by ANY path (explicit field, or a linkVisibility side
    // effect that nulls the handle / drafts the status) is caught uniformly.
    //
    // Linking (Unlinked to Linked) nests the persona under the creator's
    // profile and shows the creator's name on it, so only the creator may
    // make that switch. It is checked first, so a co-owner linking a
    // published unlinked persona (which also swaps its handle) gets this
    // reason. Unlinking keeps the rules below. The handle rule covers both
    // link kinds, since a linked persona holds a `/p/<handle>` as well.
    const isLinkingToCreatorProfile =
      prevLink === SubprofileLinkVisibility.Unlinked &&
      sp.linkVisibility === SubprofileLinkVisibility.Linked;
    if (!isCreator) {
      if (isLinkingToCreatorProfile) {
        throw new ForbiddenException(
          'Only the persona creator can link it to their profile',
        );
      }
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

    // The creator-only changes the gate above refuses to non-creators. When
    // the edit makes one, the save re-checks the creator under the row lock,
    // since the creator role can move to another co-owner between the read
    // above and the write (`transferCreatorWithin`).
    const hasCreatorOnlyChange =
      isLinkingToCreatorProfile ||
      (sp.handle ?? null) !== (prevHandle ?? null) ||
      SubprofilesService.VISIBILITY_RANK[sp.visibility] >
        SubprofilesService.VISIBILITY_RANK[prevVisibility] ||
      (prevStatus === SubprofileStatus.Published &&
        sp.status === SubprofileStatus.Draft);
    const saveOptions: SubprofileEditSaveOptions = {
      editorUserId: userId,
      hasEditedSlug: rest.slug !== undefined && rest.slug !== prevSlug,
      // Read before the transaction below assigns a claimed or derived name,
      // which then sets the flag for its own save. A link switch owns the
      // handle as well (it clears or re-claims it).
      hasEditedHandle:
        (sp.handle ?? null) !== (prevHandle ?? null) ||
        sp.linkVisibility !== prevLink,
      // The merged state: a `null` or resent `linkVisibility` is no switch.
      hasEditedLinkVisibility: sp.linkVisibility !== prevLink,
      hasLinkDependentChange:
        sp.status !== prevStatus ||
        (sp.handle ?? null) !== (prevHandle ?? null),
      loadedLinkVisibility: prevLink,
      loadedStatus: prevStatus,
      requiredCreatorUserId: hasCreatorOnlyChange ? userId : undefined,
      // ENG-451: refused with the 409 under the row lock when stale, and
      // raised by 1 on every successful PATCH, sent or not.
      expectedEditVersion,
      shouldAdvanceEditVersion: true,
    };

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

    // A linked draft stores its `/p/<handle>` on the row, so the owner can
    // preview that address before publish (see `deriveLinkedDraftHandle`).
    // This edit leaves one without a handle when it links a draft, clears
    // the handle field, or saves a row stored before this rule. The name is
    // filled in under the row lock below. The creator-only gate and
    // `saveOptions` above were decided on the user's own input first, so a
    // co-owner's unrelated edit never reads as a handle change.
    const shouldDeriveLinkedDraftHandle =
      sp.linkVisibility === SubprofileLinkVisibility.Linked &&
      sp.status !== SubprofileStatus.Published &&
      !sp.handle;

    // The handle typed in this edit, captured once before the transaction so
    // every retry after a lost derived-handle race claims from the same
    // input. A claim that loses the race rejects before its `await` can
    // assign `sp.handle`, so the snapshot only keeps each run independent of
    // whatever the transaction body writes to `sp`.
    const typedLinkedHandle = shouldClaimLinkedHandleNow ? sp.handle : null;
    // The same snapshot for the handle a published persona is renamed to.
    const typedRenamedHandle = shouldRenamePublishedHandle
      ? (sp.handle ?? null)
      : null;
    if (
      saveOptions.hasEditedLinkVisibility ||
      shouldDeriveLinkedDraftHandle ||
      shouldRenamePublishedHandle
    ) {
      try {
        await this.retryLostDerivedHandleRace(() =>
          this.dataSource.transaction(async (m) => {
            // The persona row lock comes FIRST, before any handle row is
            // touched: every transaction here takes the persona row and then
            // the handle row, in that order, so two of them can never wait on
            // each other. It also refuses a former member or creator before
            // anything is released.
            const current = await this.lockCurrentSubprofile(
              m,
              sp.id,
              saveOptions,
            );
            if (saveOptions.hasEditedLinkVisibility) {
              // The switch was decided on the loaded link and status, so a
              // row that moved since is refused before any registry work
              // (the save below would refuse it too, after the fact).
              if (
                current.linkVisibility !== prevLink ||
                current.status !== prevStatus
              ) {
                throw new PersonaChangedMeanwhileException(current.editVersion);
              }
              // Either direction frees the name the COMMITTED row holds while
              // published: a creator transfer or a rename that committed
              // while this edit waited on the lock may have moved it off the
              // loaded one. No forwarding: the old address leading to the
              // new one would tie a pseudonymous persona to the member who
              // runs it.
              if (
                current.status === SubprofileStatus.Published &&
                current.handle
              ) {
                await this.handles.release(
                  m,
                  current.handle,
                  subprofileHandleOwner(sp.id),
                  { isForwarding: false },
                );
              }
              // A link switch cuts every address the persona held before it,
              // so names an earlier rename released stop forwarding too.
              await this.handles.stopForwardingFor(m, sp.id);
            }
            if (isUnlinkingSwitch) {
              await this.cutTiesToNamedPersona(m, sp.id);
            }
            // Set when this run assigns `sp.handle` below, so the save keeps
            // that name over the committed one. Fresh per retry.
            let hasAssignedHandle = saveOptions.hasEditedHandle;
            if (shouldRenamePublishedHandle) {
              hasAssignedHandle = true;
              sp.handle = await this.renamePublishedHandle(m, current, {
                previousHandle: prevHandle,
                typedHandle: typedRenamedHandle,
                loadedLinkVisibility: prevLink,
                personaSlug: saveOptions.hasEditedSlug ? sp.slug : current.slug,
              });
            }
            if (shouldClaimLinkedHandleNow) {
              hasAssignedHandle = true;
              sp.handle = await this.claimHandleForNewlyLinkedPersona(
                m,
                current,
                typedLinkedHandle,
                saveOptions.hasEditedSlug ? sp.slug : current.slug,
              );
            }
            // Derived from the creator and slug on the locked row (the slug
            // this edit sets, if any). Skipped when the committed link or
            // status moved since the load: the save below then refuses the
            // edit or keeps the committed link state, handle included.
            const hasLinkOrStatusMovedMeanwhile =
              current.linkVisibility !== prevLink ||
              current.status !== prevStatus;
            if (
              shouldDeriveLinkedDraftHandle &&
              !hasLinkOrStatusMovedMeanwhile
            ) {
              hasAssignedHandle = true;
              sp.handle = await this.deriveLinkedDraftHandle(
                m,
                sp.id,
                current.userId,
                saveOptions.hasEditedSlug ? sp.slug : current.slug,
              );
            }
            // Writes the claimed or derived `handle` too: a link switch
            // keeps the edit's own link state, status and handle.
            await this.applyCommittedColumnsAndSave(m, sp, current, {
              ...saveOptions,
              hasEditedHandle: hasAssignedHandle,
            });
          }),
        );
      } catch (err) {
        this.throwConflictOnUniqueViolation(err);
      }
    } else {
      await this.saveSubprofile(sp, saveOptions);
    }
    return this.ownerDTO(sp);
  }

  async replaceSection(
    userId: string,
    id: string,
    section: string,
    items: SubprofileItemInputDTO[],
    expectedEditVersion?: number,
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

    // "A persona you follow published something new" (PRD-208). Snapshotted
    // BEFORE the write for the same reason the credit diff above is: the old
    // rows are gone once the transaction commits, so "did this section grow,
    // and by what?" can only be asked now. The answer is used post-commit.
    const sectionTitlesBefore = await this.updates.snapshotSectionTitles(
      id,
      sectionEnum,
    );

    sp.editVersion = await this.dataSource.transaction(async (manager) => {
      // ENG-451: the persona row lock and the edit-version precondition come
      // first, before any item row is read or written.
      const advancedEditVersion = await this.lockAndAdvanceEditVersion(
        manager,
        id,
        userId,
        expectedEditVersion,
      );

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

      // Co-owner upload rule (see `assertNoForeignUploadIntroduced`): a
      // collaborator may keep an item image another collaborator uploaded, but
      // may not introduce a foreign upload this section does not already hold.
      // Runs before the first write in this transaction.
      const storedItemImages = existingRows.map((row) => row.imageUrl);
      for (const item of items) {
        this.assertNoForeignUploadIntroduced(
          userId,
          item.imageUrl,
          storedItemImages,
        );
      }

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
      return advancedEditVersion;
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

    // Followers, post-commit and best-effort on the same terms: the service
    // swallows its own failures, so a bell that did not ring can never roll
    // back or fail a save that already succeeded.
    await this.updates.notifyFollowersOfNewItems(
      sp,
      sectionTitlesBefore,
      items.map((item) => item.title),
      sectionEnum,
    );

    return this.ownerDTO(sp);
  }

  async replaceSocialLinks(
    userId: string,
    id: string,
    items: { platform: string; urlOrHandle: string }[],
    expectedEditVersion?: number,
  ): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);

    if (!validateSocialLinks(items)) {
      throw new BadRequestException('Invalid social links');
    }

    sp.editVersion = await this.dataSource.transaction(async (manager) => {
      // ENG-451: lock and precondition first, before the delete.
      const advancedEditVersion = await this.lockAndAdvanceEditVersion(
        manager,
        id,
        userId,
        expectedEditVersion,
      );
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
      return advancedEditVersion;
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
  // rather than a serial `findOne` + `isBlockedEitherWay` per item. On top of
  // those checks, the persona's owners must belong to every target (a member
  // of the community, or going to the event), checked in one more batch by
  // `SubprofileAffiliationEligibilityService`.
  async replaceAffiliations(
    userId: string,
    id: string,
    items: { targetType: string; targetSlug: string; role: string }[],
    expectedEditVersion?: number,
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
      // `hostId` is null once the host's account is erased
      // (`SetNullContentAuthorFksOnUserErasure1794610000000`): the same shape
      // an ownerless community already has below: no user left to block-check
      // against, so it is skipped.
      if (
        event.status === EventStatus.Published &&
        event.visibility !== EventVisibility.InviteOnly &&
        event.hostId !== null
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
        community.archivedAt == null &&
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
          (event.hostId !== null && blockedOwnerIds.has(event.hostId))
        ) {
          throw new BadRequestException(
            `Affiliation target not found or not visible: ${label}`,
          );
        }
      } else {
        const community = communityBySlug.get(item.targetSlug);
        // An archived community 404s for everyone off its roster and is
        // hidden from every listing, so it is treated as not visible here.
        if (
          !community ||
          community.accessTier === AccessTier.Private ||
          community.archivedAt != null ||
          (community.ownerId !== null && blockedOwnerIds.has(community.ownerId))
        ) {
          throw new BadRequestException(
            `Affiliation target not found or not visible: ${label}`,
          );
        }
      }
    }

    // Every target exists and is visible, so the owners must also belong to
    // it: a community member of any roster role, or going to the event (see
    // `SubprofileAffiliationEligibilityService`). Batched over this persona's
    // owners and every item's target. The message reaches the owner verbatim
    // in a toast, so it names the target by its real name.
    if (items.length) {
      const ownerIds =
        (await this.affiliationEligibility.ownerIdsFor([id])).get(id) ?? [];
      const linkedEventRows = items.flatMap((item) => {
        const event =
          item.targetType === 'event'
            ? eventBySlug.get(item.targetSlug)
            : undefined;
        return event ? [event] : [];
      });
      const linkedCommunityIds = items.flatMap((item) => {
        const community =
          item.targetType === 'community'
            ? communityBySlug.get(item.targetSlug)
            : undefined;
        return community ? [community.id] : [];
      });
      const eligibleKeys = await this.affiliationEligibility.eligibleTargetKeys(
        ownerIds,
        linkedEventRows,
        linkedCommunityIds,
      );
      // Every lookup below hits: the loop above already threw for a missing
      // target.
      for (const item of items) {
        if (item.targetType === 'event') {
          const event = eventBySlug.get(item.targetSlug);
          if (
            event &&
            !hasQualifyingOwner(eligibleKeys, 'event', event.id, ownerIds)
          ) {
            throw new BadRequestException(
              `You can only link events you're going to. "${event.title}" isn't one of them.`,
            );
          }
        } else {
          const community = communityBySlug.get(item.targetSlug);
          if (
            community &&
            !hasQualifyingOwner(
              eligibleKeys,
              'community',
              community.id,
              ownerIds,
            )
          ) {
            throw new BadRequestException(
              `You can only link communities you're a member of. "${community.name}" isn't one of them.`,
            );
          }
        }
      }
    }

    sp.editVersion = await this.dataSource.transaction(async (manager) => {
      // ENG-451: lock and precondition first, before the delete.
      const advancedEditVersion = await this.lockAndAdvanceEditVersion(
        manager,
        id,
        userId,
        expectedEditVersion,
      );
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
      return advancedEditVersion;
    });

    return this.ownerDTO(sp);
  }

  // The "Part of" picker's choices: every event and community the REQUESTING
  // owner belongs to that `replaceAffiliations` would accept. A co-owner's
  // memberships and RSVPs are theirs to keep private, so they are left out;
  // links a co-owner already saved still pass the any-owner rule on save and
  // read, and the editor shows them from the owner DTO. Gated by `getOwned`
  // (404 for no persona, 403 for a non-owner) like every other owner read.
  // Blocks are checked against both the persona's `userId` (the party the
  // save-time check uses) and the requester.
  async listAffiliationOptions(
    userId: string,
    id: string,
  ): Promise<AffiliationOption[]> {
    const subprofile = await this.getOwned(userId, id);
    return this.affiliationEligibility.listOptions(userId, subprofile.userId);
  }

  async publish(userId: string, id: string): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);
    const items = await this.items.find({ where: { subprofileId: id } });
    const socialLinkRows = await this.socialLinks.find({
      where: { subprofileId: id },
      order: { position: 'ASC' },
    });
    const subprofileOwner = subprofileHandleOwner(sp.id);

    // The CREATOR's profile (`subprofiles.user_id`), whoever is publishing: a
    // linked persona with no handle derives `<creatorSlug>-<personaSlug>`
    // from it, and an unlinked persona's handle may not carry its slug.
    const creatorProfile = await this.dataSource.manager.findOne(Profile, {
      where: { userId: sp.userId },
    });
    const isDerived = !sp.handle;
    if (
      sp.linkVisibility === SubprofileLinkVisibility.Linked &&
      isDerived &&
      !creatorProfile
    ) {
      throw missingCreatorProfileException();
    }

    // `handle_taken` reflects the WHOLE global namespace (main usernames +
    // every other subprofile handle), for both link kinds. Excluding this
    // persona's own owner lets a re-publish of the same name pass.
    let handleTaken = false;
    if (sp.handle) {
      handleTaken = await this.handles.isTaken(
        this.dataSource.manager,
        sp.handle,
        subprofileOwner,
      );
    }

    const unmet = validatePublish(
      sp,
      items,
      handleTaken,
      creatorProfile?.slug ?? null,
    );
    if (unmet.length) {
      throw new UnprocessableEntityException({
        code: 'SUBPROFILE_NOT_READY',
        message: 'This persona is not ready to publish yet.',
        unmet,
      });
    }

    // Single-persona co-owner headcount for the response (Personas redesign
    // Phase 2 dashboard plan Decision §5).
    const memberCount =
      (await this.membership.loadMemberCountsFor([sp.id])).get(sp.id) ?? 1;
    const crops = await this.mediaCropService.getMany(imageKeysFor(sp, items));

    // Claim the handle in the global registry AND flip to published in ONE
    // transaction, for both link kinds, so a lost race on the name fails
    // atomically (the row stays a draft). INVARIANT: a registry row exists
    // for a persona IFF it is currently published, whatever its link kind,
    // and that row's name equals its `handle`. So an already-published
    // re-publish renames `handle` to itself (a no-op that keeps the existing
    // claim); a draft renames `null` to its handle (a fresh claim). A linked
    // persona with no handle claims the one derived here, and a derived name
    // lost to a concurrent writer is derived again (the next suffix), up to
    // `MAX_DERIVED_HANDLE_CLAIM_ATTEMPTS` times.
    const existingClaimedName =
      sp.status === SubprofileStatus.Published ? sp.handle : null;
    const claimedName = await this.retryLostDerivedHandleRace(() =>
      this.dataSource.transaction(async (m) => {
        // Persona row lock before the handle row, the order every
        // transaction here keeps; it also refuses an editor who has left.
        const current = await this.lockCurrentSubprofile(m, sp.id, {
          editorUserId: userId,
        });
        // The claim below was decided on the loaded row. If the link, status
        // or handle moved meanwhile (the creator switched it, or another
        // publish claimed the name), claiming now would leave a registry row
        // the persona no longer matches. `sp.status` is still the loaded
        // value here.
        const hasPersonaMovedMeanwhile =
          current.linkVisibility !== sp.linkVisibility ||
          current.status !== sp.status ||
          (current.handle ?? null) !== (sp.handle ?? null);
        if (hasPersonaMovedMeanwhile) {
          throw new PersonaChangedMeanwhileException(current.editVersion);
        }
        const nameToClaim =
          sp.handle ??
          (await this.deriveLinkedPersonaHandleUnderLock(
            m,
            current,
            creatorProfile,
            current.slug,
          ));
        await this.claimPersonaHandle(
          m,
          existingClaimedName,
          nameToClaim,
          sp.id,
          isDerived,
        );
        await m.update(
          Subprofile,
          { id: sp.id },
          { status: SubprofileStatus.Published, handle: nameToClaim },
        );
        return nameToClaim;
      }),
    );
    sp.handle = claimedName;
    sp.status = SubprofileStatus.Published;
    // The profiles `ActivityListener` records a "Published a persona" row
    // from this. It re-reads the persona and applies its own gate (published,
    // `open` visibility, LINKED, not removed), so that rule lives in exactly
    // one place and emitting on every publish is correct: an unlinked persona
    // is dropped there rather than being filtered twice.
    this.eventEmitter.emit(SUBPROFILE_PUBLISHED, {
      subprofileId: sp.id,
      ownerUserId: sp.userId,
    } satisfies SubprofilePublishedEvent);
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
    if (sp.handle) {
      // Free the global name AND draft the status in ONE transaction, so the
      // registry and the row can never disagree. Both link kinds hold a
      // handle while published (see the invariant on `publish`). An unlinked
      // draft drops its handle. A linked draft keeps it on the row with no
      // registry claim, so the owner's `/p/` preview still works, and a
      // republish claims that stored name again (or surfaces `handle_taken`
      // if someone took it meanwhile).
      const handle = sp.handle;
      const isLinked = sp.linkVisibility === SubprofileLinkVisibility.Linked;
      const handleAfterUnpublish = isLinked ? handle : null;
      await this.dataSource.transaction(async (m) => {
        // Persona row lock before the handle row, the order every
        // transaction here keeps. Re-checks the creator under it: the gate
        // above read the row before any lock, and the creator role may have
        // moved since.
        const current = await this.lockCurrentSubprofile(m, sp.id, {
          editorUserId: userId,
          requiredCreatorUserId: userId,
        });
        // A handle edit or link switch committed since the load holds a
        // different name; releasing the loaded one would leave that claim
        // behind on a draft. A link switch alone also moves which handle
        // the draft keeps, so it is refused the same way.
        if (
          (current.handle ?? null) !== handle ||
          current.linkVisibility !== sp.linkVisibility
        ) {
          throw new PersonaChangedMeanwhileException(current.editVersion);
        }
        await this.handles.release(m, handle, subprofileHandleOwner(sp.id));
        await m.update(
          Subprofile,
          { id: sp.id },
          { status: SubprofileStatus.Draft, handle: handleAfterUnpublish },
        );
      });
      sp.status = SubprofileStatus.Draft;
      sp.handle = handleAfterUnpublish;
    } else {
      const loadedStatus = sp.status;
      sp.status = SubprofileStatus.Draft;
      await this.saveSubprofile(sp, {
        editorUserId: userId,
        hasEditedSlug: false,
        hasEditedHandle: false,
        hasEditedLinkVisibility: false,
        hasLinkDependentChange: true,
        loadedLinkVisibility: sp.linkVisibility,
        loadedStatus,
        requiredCreatorUserId: userId,
      });
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
    // The gate above read the persona before any lock. The delete runs under
    // the persona row lock that every roster writer and the creator transfer
    // take first, and re-checks the caller as creator on the locked row: a
    // concurrent `leave` may have handed the persona to a successor since,
    // and a stale delete would destroy it for every remaining co-owner. Lock
    // order stays persona row, then the handle row the delete releases.
    const deleted = await this.dataSource.transaction(async (manager) => {
      const current = await this.lockCurrentSubprofile(manager, id, {
        editorUserId: userId,
        requiredCreatorUserId: userId,
      });
      // Capture the co-owner roster BEFORE the delete cascades away the
      // `subprofile_members` rows. The deletion notification fans out to
      // every co-owner except the creator who initiated it.
      const memberRows = await manager.find(SubprofileMember, {
        where: { subprofileId: id },
        select: { userId: true },
      });
      const coOwnerIds = memberRows
        .map((row) => row.userId)
        .filter((memberUserId) => memberUserId !== current.userId);
      const displayName = current.displayName;
      // ENG-449: release the persona's registry handle BEFORE the row goes,
      // with no forwarding, so the name stays reserved for the reclaim
      // cooldown and no printed QR or shared `/p/` link opens a stranger's
      // page the moment the persona is gone. The reservation (and
      // every older one the persona left) survives the delete:
      // `handle_history.previous_owner_subprofile_id` is `ON DELETE SET NULL`
      // (`1824710000000-KeepHandleHistoryOnPersonaDelete`). Read by owner, so
      // a registry row whose name drifted from `handle` is released too.
      await this.releaseRegistryHandlesBeforeDelete(manager, current.id);
      // `subprofile_items` cascade via their FK on `subprofile_id`.
      await manager.remove(current);
      return { coOwnerIds, displayName };
    });
    // Emitted AFTER the commit: a listener must never observe a persona
    // that could still exist. Best-effort: the delete already committed, so a
    // notification failure must not surface as an error to the caller.
    if (deleted.coOwnerIds.length) {
      this.eventEmitter.emit(SUBPROFILE_DELETED, {
        subprofileId: id,
        displayName: deleted.displayName,
        deletedByUserId: userId,
        coOwnerIds: deleted.coOwnerIds,
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
    query: ListSubprofileDirectoryQuery,
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

  // The viewer's OWN following list — every persona they follow that is still
  // publicly readable to them (PRD-208).
  listFollowedPersonas(
    viewerId: string,
    page?: number,
  ): Promise<Paginated<FollowedPersonaView>> {
    return this.followersService.listFollowedPersonas(viewerId, page);
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

  /**
   * Persist a whole-entity edit of `sp` (loaded earlier by `getOwned`, with no
   * lock) in its own transaction. See `saveEditUnderLock`.
   */
  private async saveSubprofile(
    sp: Subprofile,
    options: SubprofileEditSaveOptions,
  ): Promise<void> {
    try {
      await this.dataSource.transaction((manager) =>
        this.saveEditUnderLock(manager, sp, options),
      );
    } catch (err) {
      this.throwConflictOnUniqueViolation(err);
    }
  }

  /**
   * Save an edit of `sp` without ever writing back a stale creator or address.
   *
   * `sp` was read before any lock, and the creator role can move to another
   * co-owner meanwhile (`transferCreatorWithin`, which rewrites `user_id`,
   * may suffix `slug` and may re-issue a creator-named `handle`). TypeORM's
   * `save` writes every column whose in-memory value differs from the
   * database, so saving the stale copy as is would put the old creator, slug
   * and handle back. This re-reads the row under `pessimistic_write`, the
   * lock the transfer holds while it writes, and copies the committed
   * `userId` (and `slug`, `handle` and the link state, unless this edit
   * changes them) onto `sp` before saving. Re-reading and applying
   * the edit to the fresh values keeps `save`'s own behaviour, including the
   * `updatedAt` it writes back onto `sp` for the response, and the response
   * then shows the persona's current creator and address.
   *
   * The same holds for the moderation-owned column: `removedAt`, the
   * moderator removal that withholds the persona from every public read, is
   * always taken from the locked row, so a stale edit can never lift a
   * removal committed after it was loaded. No member edit sets it. It is the
   * only such column on `subprofiles`: moderator takedowns live in
   * `content_moderation`, and the row has no moderator-set visibility,
   * verified or claimed flag.
   *
   * The locked read also re-checks the editor (`lockCurrentSubprofile`): a
   * member who left meanwhile gets the membership 403, and
   * `requiredCreatorUserId` re-runs the creator gate for an edit only the
   * creator may make.
   */
  private async saveEditUnderLock(
    manager: EntityManager,
    sp: Subprofile,
    options: SubprofileEditSaveOptions,
  ): Promise<void> {
    const current = await this.lockCurrentSubprofile(manager, sp.id, options);
    await this.applyCommittedColumnsAndSave(manager, sp, current, options);
  }

  /** The second half of `saveEditUnderLock`, for a caller that already holds
   * the locked row `current` (read by `lockCurrentSubprofile` in the same
   * transaction). */
  private async applyCommittedColumnsAndSave(
    manager: EntityManager,
    sp: Subprofile,
    current: Subprofile,
    options: SubprofileEditSaveOptions,
  ): Promise<void> {
    // `save` would write back the loaded `linkVisibility`, so a stale edit
    // could re-link a persona that was unlinked meanwhile (or unlink one that
    // was linked). An edit that does not itself switch the link keeps the
    // committed link state, like `slug`. The link switch also owns `status`
    // (unlinking drafts it) and `handle` (a switch releases the old name and
    // clears or re-claims it), so those follow the committed row too. A
    // publish, unpublish or handle edit was decided against the loaded link
    // state and is refused instead. A link switch is refused too when the
    // committed link or status moved: switching a row published since the
    // load would skip releasing the name that publish claimed, or silently
    // revert that publish.
    const hasSwitchedLinkOverMovedRow =
      options.hasEditedLinkVisibility &&
      (current.linkVisibility !== options.loadedLinkVisibility ||
        current.status !== options.loadedStatus);
    if (hasSwitchedLinkOverMovedRow) {
      throw new PersonaChangedMeanwhileException(current.editVersion);
    }
    const hasLinkMovedMeanwhile =
      !options.hasEditedLinkVisibility &&
      current.linkVisibility !== sp.linkVisibility;
    if (hasLinkMovedMeanwhile) {
      if (options.hasLinkDependentChange) {
        throw new PersonaChangedMeanwhileException(current.editVersion);
      }
      sp.linkVisibility = current.linkVisibility;
      sp.status = current.status;
      sp.handle = current.handle;
    }
    sp.userId = current.userId;
    sp.removedAt = current.removedAt;
    // `edit_version` (ENG-451) is committed state as well: saving the loaded
    // copy as is would put an older counter back. The PATCH editor write
    // raises it by exactly 1 over the locked row; any other save keeps it.
    sp.editVersion = options.shouldAdvanceEditVersion
      ? current.editVersion + 1
      : current.editVersion;
    if (!options.hasEditedSlug) {
      sp.slug = current.slug;
    }
    // `handle` is committed state too (PRD-431): a creator transfer re-issues
    // a creator-named handle under this same lock without moving the link or
    // bumping `edit_version`, so an edit loaded before it would otherwise
    // write the departed creator's name back over the re-issued one. An
    // edit that sets the handle itself keeps its own: those paths already
    // refuse a row whose handle moved (`renamePublishedHandle`, publish).
    if (!options.hasEditedHandle) {
      sp.handle = current.handle;
    }
    await manager.save(sp);
  }

  /** The `<creatorSlug>-<personaSlug>` handle a linked DRAFT stores on its
   * row, so the owner's `/p/<handle>` preview works before publish. It
   * claims no registry row, since a draft holds none (see the invariant on
   * `publish`), and publish claims the stored name like a typed one. A
   * candidate is skipped when the registry holds it or a reservation still
   * cools it for anyone but this persona, and when another subprofile row
   * already stores it (any status), so `/p/` resolves one persona per name.
   * `subprofileId` is undefined for a row not inserted yet. Returns null
   * when the creator has no profile to build the name from, or no candidate
   * is free, so the save still goes ahead: the nested address keeps serving
   * the draft, and publish derives or reports the name itself. */
  private async deriveLinkedDraftHandle(
    manager: EntityManager,
    subprofileId: string | undefined,
    creatorUserId: string,
    personaSlug: string,
  ): Promise<string | null> {
    const creatorProfile = await manager.findOne(Profile, {
      where: { userId: creatorUserId },
    });
    if (!creatorProfile) {
      return null;
    }
    const owner = subprofileId
      ? subprofileHandleOwner(subprofileId)
      : undefined;
    try {
      return await deriveLinkedPersonaHandle(
        creatorProfile.slug,
        personaSlug,
        async (candidate) => {
          if (await this.handles.isTaken(manager, candidate, owner)) {
            return false;
          }
          const isStoredByAnotherSubprofile = await manager.exists(Subprofile, {
            where: subprofileId
              ? { handle: candidate, id: Not(subprofileId) }
              : { handle: candidate },
          });
          return !isStoredByAnotherSubprofile;
        },
      );
    } catch (err) {
      if (err instanceof ConflictException) {
        return null;
      }
      throw err;
    }
  }

  /** Runs a claim transaction, and runs it again (up to
   * `MAX_DERIVED_HANDLE_CLAIM_ATTEMPTS` in all) while a server-derived handle
   * keeps losing its race. Each run re-derives, so it moves on to the next
   * free suffix. Any other error passes straight through. */
  private async retryLostDerivedHandleRace<Result>(
    runClaimTransaction: () => Promise<Result>,
  ): Promise<Result> {
    for (
      let attempt = 1;
      attempt <= MAX_DERIVED_HANDLE_CLAIM_ATTEMPTS;
      attempt += 1
    ) {
      try {
        return await runClaimTransaction();
      } catch (err) {
        if (!(err instanceof LostDerivedHandleRaceError)) {
          throw err;
        }
      }
    }
    throw new ConflictException({
      code: 'handle_derivation_failed',
      message: 'We could not find a free address for this persona.',
    });
  }

  /** Moves the persona's registry claim from `previousName` to
   * `nameToClaim`. A name taken meanwhile is a lost race when the server
   * derived it (the caller retries) and the publish checklist's
   * `handle_taken` when the owner typed it. */
  private async claimPersonaHandle(
    manager: EntityManager,
    previousName: string | null,
    nameToClaim: string,
    subprofileId: string,
    isDerived: boolean,
  ): Promise<void> {
    try {
      await this.handles.rename(
        manager,
        previousName,
        nameToClaim,
        subprofileHandleOwner(subprofileId),
      );
    } catch (err) {
      if (!(err instanceof ConflictException)) {
        throw err;
      }
      if (isDerived) {
        throw new LostDerivedHandleRaceError();
      }
      throw new UnprocessableEntityException({
        code: 'SUBPROFILE_NOT_READY',
        message: 'That handle was just taken. Choose another.',
        unmet: ['handle_taken'],
      });
    }
  }

  /** A linked persona's default handle, `<creatorSlug>-<personaSlug>`, from
   * the creator on the LOCKED row (a creator transfer may have committed since
   * the load). `loadedCreatorProfile` saves the read when it is that same
   * creator's profile. Availability is read in the claim transaction. */
  private async deriveLinkedPersonaHandleUnderLock(
    manager: EntityManager,
    current: Subprofile,
    loadedCreatorProfile: Profile | null,
    personaSlug: string,
  ): Promise<string> {
    const creatorProfile =
      loadedCreatorProfile?.userId === current.userId
        ? loadedCreatorProfile
        : await manager.findOne(Profile, {
            where: { userId: current.userId },
          });
    if (!creatorProfile) {
      throw missingCreatorProfileException();
    }
    const owner = subprofileHandleOwner(current.id);
    return deriveLinkedPersonaHandle(
      creatorProfile.slug,
      personaSlug,
      async (candidate) =>
        !(await this.handles.isTaken(manager, candidate, owner)),
    );
  }

  /** The handle a published persona claims as the creator links it: the one
   * typed in the same edit, checked like a linked publish (namespace checks,
   * the kind-name check and the blocked-term screen), or the derived default.
   * Runs after the old name was released, so it claims from nothing. */
  private async claimHandleForNewlyLinkedPersona(
    manager: EntityManager,
    current: Subprofile,
    typedHandle: string | null,
    personaSlug: string,
  ): Promise<string> {
    if (typedHandle) {
      const handleTaken = await this.handles.isTaken(
        manager,
        typedHandle,
        subprofileHandleOwner(current.id),
      );
      const unmet = linkedHandleUnmetCodes(
        typedHandle,
        handleTaken,
        current.kind,
      );
      if (unmet.length) {
        throw new UnprocessableEntityException({
          code: 'SUBPROFILE_NOT_READY',
          message: 'That handle is not available.',
          unmet,
        });
      }
      await this.claimPersonaHandle(
        manager,
        null,
        typedHandle,
        current.id,
        false,
      );
      return typedHandle;
    }
    const derivedHandle = await this.deriveLinkedPersonaHandleUnderLock(
      manager,
      current,
      null,
      personaSlug,
    );
    await this.claimPersonaHandle(
      manager,
      null,
      derivedHandle,
      current.id,
      true,
    );
    return derivedHandle;
  }

  /**
   * PRD-427: the handle a PUBLISHED persona takes when its owner changes it
   * with no link switch. The persona stays published, so in the edit's
   * transaction the new name passes the checks publish runs on a handle, the
   * registry claim moves to it, and the old name is released WITH forwarding
   * (`HandlesService.rename`), so `PERSONA_MOVED` sends old links to the new
   * address during the cooldown.
   *
   * - A typed handle that another owner holds (or that sits in someone
   *   else's cooldown) is a 409, and nothing changes: the check runs before
   *   any write, and a claim lost to a concurrent writer throws inside the
   *   transaction, which rolls back.
   * - Any other failed check is the publish checklist's 422.
   * - A cleared handle on a linked persona claims its derived default
   *   (`<creatorSlug>-<personaSlug>`); an unlinked persona has no default,
   *   so clearing is refused with `handle_invalid` (unpublishing is how it
   *   goes offline).
   *
   * Decided on the loaded row, so a status, link or handle change committed
   * since the load is refused with the 409 before the registry is touched.
   */
  private async renamePublishedHandle(
    manager: EntityManager,
    current: Subprofile,
    rename: {
      previousHandle: string | null;
      typedHandle: string | null;
      loadedLinkVisibility: SubprofileLinkVisibility;
      personaSlug: string;
    },
  ): Promise<string> {
    const { previousHandle, typedHandle, loadedLinkVisibility, personaSlug } =
      rename;
    const hasPersonaMovedMeanwhile =
      current.status !== SubprofileStatus.Published ||
      current.linkVisibility !== loadedLinkVisibility ||
      (current.handle ?? null) !== (previousHandle ?? null);
    if (hasPersonaMovedMeanwhile) {
      throw new PersonaChangedMeanwhileException(current.editVersion);
    }
    const isLinked = current.linkVisibility === SubprofileLinkVisibility.Linked;
    if (!typedHandle) {
      if (!isLinked) {
        throw new UnprocessableEntityException({
          code: 'SUBPROFILE_NOT_READY',
          message:
            'A published persona needs an address. Unpublish it to take it offline.',
          unmet: ['handle_invalid'],
        });
      }
      const derivedHandle = await this.deriveLinkedPersonaHandleUnderLock(
        manager,
        current,
        null,
        personaSlug,
      );
      await this.claimPersonaHandle(
        manager,
        previousHandle,
        derivedHandle,
        current.id,
        true,
      );
      return derivedHandle;
    }
    const owner = subprofileHandleOwner(current.id);
    const handleTaken = await this.handles.isTaken(manager, typedHandle, owner);
    const creatorProfile = isLinked
      ? null
      : await manager.findOne(Profile, { where: { userId: current.userId } });
    const unmet = publishedHandleUnmetCodes(
      typedHandle,
      handleTaken,
      current,
      creatorProfile?.slug ?? null,
    );
    if (unmet.includes('handle_taken')) {
      throw handleTakenOnRenameException();
    }
    if (unmet.length) {
      throw new UnprocessableEntityException({
        code: 'SUBPROFILE_NOT_READY',
        message: 'That handle is not available.',
        unmet,
      });
    }
    // Releases the old name with forwarding, then claims the new one. A
    // name taken since the check above gets the same 409 body as the check,
    // so the frontend reads one shape for a taken handle.
    try {
      await this.handles.rename(manager, previousHandle, typedHandle, owner);
    } catch (err) {
      if (err instanceof ConflictException) {
        throw handleTakenOnRenameException();
      }
      throw err;
    }
    return typedHandle;
  }

  /**
   * ENG-447: the clean break when a linked persona goes unlinked. Nothing
   * that belonged to the named persona carries to its pseudonymous address:
   * its follower rows, its endorsements (withdrawn ones too, since each can
   * carry a note written to the named owner), and every old nested
   * `/members/<creator>/<slug>` address recorded for it on a creator
   * transfer. Follower and endorsement counts are computed from these rows,
   * so they read zero from the next request. Pending invites and co-owners
   * stay: they are owners. Runs in the switch's transaction, so a refused
   * switch keeps every row.
   */
  private async cutTiesToNamedPersona(
    manager: EntityManager,
    subprofileId: string,
  ): Promise<void> {
    await manager.delete(SubprofileFollower, { subprofileId });
    await manager.delete(SubprofileEndorsement, { subprofileId });
    await manager.delete(SubprofileAddressHistory, { subprofileId });
  }

  /**
   * ENG-449: frees every registry name the persona holds before its row is
   * deleted, through `HandlesService.release` with no forwarding, so each
   * name stays reserved for the reclaim cooldown and no old link ever leads
   * anywhere. Read by owner: by the registry invariant this is the published
   * persona's `handle`, and a draft holds none.
   */
  private async releaseRegistryHandlesBeforeDelete(
    manager: EntityManager,
    subprofileId: string,
  ): Promise<void> {
    const heldHandles = await manager.find(Handle, {
      where: { ownerKind: HandleOwnerKind.Subprofile, subprofileId },
      select: { name: true },
    });
    for (const heldHandle of heldHandles) {
      await this.handles.release(
        manager,
        heldHandle.name,
        subprofileHandleOwner(subprofileId),
        { isForwarding: false },
      );
    }
  }

  /** The persona row under `pessimistic_write`, the lock every roster writer
   * and the creator transfer take first. Under it: an editor with no roster
   * row any more gets the same 403 `getOwned` gives, and with
   * `requiredCreatorUserId`, a caller who is no longer the creator gets the
   * creator-only 403. Roster writers take this lock before they change the
   * roster, so the membership read here is current. */
  private async lockCurrentSubprofile(
    manager: EntityManager,
    id: string,
    checks: SubprofileLockChecks,
  ): Promise<Subprofile> {
    const current = await manager.findOne(Subprofile, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!current) {
      throw new NotFoundException('Subprofile not found');
    }
    const editorMembershipCount = await manager.count(SubprofileMember, {
      where: { subprofileId: id, userId: checks.editorUserId },
    });
    if (editorMembershipCount === 0) {
      throw new ForbiddenException('Not your subprofile');
    }
    const { requiredCreatorUserId } = checks;
    if (
      requiredCreatorUserId !== undefined &&
      current.userId !== requiredCreatorUserId
    ) {
      throw new ForbiddenException(
        'Only the persona creator can make this change',
      );
    }
    // ENG-451: under the lock, so two saves built on the same version
    // serialize here and the second one reads the raised value.
    const { expectedEditVersion } = checks;
    if (
      expectedEditVersion !== undefined &&
      current.editVersion !== expectedEditVersion
    ) {
      throw new PersonaEditConflictException(current.editVersion);
    }
    return current;
  }

  /**
   * The persona row lock a replace-all editor write (section, social links,
   * affiliations) or an item revision restore takes first in its
   * transaction, before it touches any row (ENG-451). It re-checks the editor's roster row and a stale
   * `expectedEditVersion` under the lock (`lockCurrentSubprofile`), then
   * raises `edit_version` by exactly 1. The whole transaction rolls back if a
   * later step fails, the raise included. Returns the stored version, for the
   * response.
   */
  private async lockAndAdvanceEditVersion(
    manager: EntityManager,
    subprofileId: string,
    editorUserId: string,
    expectedEditVersion: number | undefined,
  ): Promise<number> {
    const current = await this.lockCurrentSubprofile(manager, subprofileId, {
      editorUserId,
      expectedEditVersion,
    });
    const advancedEditVersion = current.editVersion + 1;
    await manager.update(
      Subprofile,
      { id: subprofileId },
      { editVersion: advancedEditVersion },
    );
    return advancedEditVersion;
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
