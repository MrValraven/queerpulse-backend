import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { Community } from '../communities/entities/community.entity';
import { ListingDraft } from '../listing-drafts/entities/listing-draft.entity';
import { Listing, ListingStatus } from '../listings/entities/listing.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
} from '../studio/entities/studio-release.entity';
import { StudioTrack } from '../studio/entities/studio-track.entity';
import { StudioCatalogService } from '../studio/studio-catalog.service';
import { unmetPublishRequirements } from '../studio/studio-publish-rule';
import type { StudioReleaseResponse } from '../studio/studio-response';
import {
  Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { SubprofilePublicReadService } from '../subprofiles/subprofile-public-read.service';
import { Profile } from '../users/entities/profile.entity';
import type { CreatorDraftUnionRow } from './admin-creator-draft-union';
import type { DraftRef } from './creator-draft-made-for.service';
import { CreatorDraftMadeForService } from './creator-draft-made-for.service';
import {
  readDraftEnvelope,
  toCommunityDraftPreview,
  toEventDraftPreview,
  toListingDraftPreview,
} from './creator-draft-public-fields';
import type {
  AdminCreatorDraftDetail,
  AdminCreatorDraftRow,
  CreatorDraftMadeFor,
  CreatorDraftProgress,
} from './creator-draft.types';
import {
  CreatorDraftKind,
  LISTING_WIZARD_TOTAL_STEPS,
  StoredCreatorDraftKind,
} from './creator-drafts.constants';
import { CreatorDraft } from './entities/creator-draft.entity';

/** The row fields a per-kind loader builds; the union row adds the rest. */
type LoadedRowFields = Pick<
  AdminCreatorDraftRow,
  'title' | 'madeFor' | 'progress' | 'missing'
>;

/** The listing a `listing_edit` draft edits, slug already gated on `live`. */
interface EditedListing {
  ref: string;
  slug: string | null;
  name: string;
}

/** What the detail needs beyond the row, kept from the loader's read. */
type RowSource =
  | { kind: 'persona' }
  | { kind: 'studio_release' }
  | { kind: 'studio_episode'; releaseId: string }
  | { kind: 'listing'; payload: Record<string, unknown> }
  | {
      kind: 'event';
      payload: Record<string, unknown>;
      authorUserId: string;
    }
  | {
      kind: 'listing_edit';
      payload: Record<string, unknown>;
      listing: EditedListing;
    }
  | { kind: 'community'; payload: Record<string, unknown> };

interface LoadedRow {
  fields: LoadedRowFields;
  source: RowSource;
}

type LoadedRows = Map<string, LoadedRow>;

type ListingSummary = Pick<Listing, 'id' | 'ref' | 'slug' | 'name' | 'status'>;

/** Trimmed text, with blank and non-string values read as null ("Untitled"). */
function readTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The list-a-business wizard state, as `readWizardState` in
 * `listing-draft-response.ts` reads it: the object at `payload.draft`, else
 * the payload itself, so a legacy flat row still previews.
 */
function readListingWizardState(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const envelope = readDraftEnvelope(payload);
  return envelope === payload.draft ? envelope : payload;
}

/** The stored progress columns, null unless both are set. */
function storedProgress(draft: CreatorDraft): CreatorDraftProgress | null {
  if (draft.progressDone === null || draft.progressTotal === null) return null;
  return { done: draft.progressDone, total: draft.progressTotal };
}

function storedMissing(draft: CreatorDraft): string[] | null {
  return draft.missing === null ? null : [...draft.missing];
}

/** The list-a-business wizard step, clamped; a missing or non-integer step reads 0. */
function listingWizardProgress(
  payload: Record<string, unknown>,
): CreatorDraftProgress {
  const step = payload.step;
  const done =
    typeof step === 'number' && Number.isInteger(step)
      ? Math.min(Math.max(step, 0), LISTING_WIZARD_TOTAL_STEPS)
      : 0;
  return { done, total: LISTING_WIZARD_TOTAL_STEPS };
}

/** A listing that is not live has no page to link, so its slug reads null. */
function liveListingSlug(listing: ListingSummary): string | null {
  return listing.status === ListingStatus.Live ? listing.slug : null;
}

function listingMadeFor(listing: ListingSummary): CreatorDraftMadeFor {
  return {
    kind: 'listing',
    name: listing.name,
    slug: liveListingSlug(listing),
  };
}

/** Studio drafts are made for their persona; its handle links only once the persona is published. */
function studioMadeFor(persona: Subprofile): CreatorDraftMadeFor {
  return {
    kind: 'persona',
    name: persona.displayName,
    slug: persona.status === SubprofileStatus.Published ? persona.handle : null,
  };
}

/** The same in-scope checks the union and `getDraftPreviewForStaff` apply. */
function isPersonaDraftInScope(persona: Subprofile): boolean {
  return (
    persona.status === SubprofileStatus.Draft &&
    !persona.removedAt &&
    persona.visibility !== SubprofileVisibility.Private
  );
}

function toSlugAndName(
  ref: DraftRef | null,
): { slug: string; name: string } | null {
  return ref ? { slug: ref.slug, name: ref.name } : null;
}

function uniqueValues(values: readonly (string | null)[]): string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== null)),
  ];
}

/**
 * Hydrates the Admin creator drafts union rows into wire rows and builds each
 * detail preview through the allow-lists. Every loader reads one kind's page
 * of ids in one batched query; the owners of a page resolve in one lookup.
 * No title, name or payload reaches a log line or an exception message.
 */
@Injectable()
export class AdminCreatorDraftRowsService {
  /**
   * The author id and the record half the detail needs, kept beside each row
   * this service built. A `WeakMap` keyed by the row object (the choice the
   * plan left open): the row stays the plain wire shape, the author id never
   * rides on it when `owner` is null, and an entry goes with its row. A row
   * built elsewhere has no entry, so `detailFor` answers null for it.
   */
  private readonly sources = new WeakMap<AdminCreatorDraftRow, RowSource>();

  constructor(
    @InjectRepository(CreatorDraft)
    private readonly creatorDrafts: Repository<CreatorDraft>,
    @InjectRepository(ListingDraft)
    private readonly listingDrafts: Repository<ListingDraft>,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(StudioRelease)
    private readonly releases: Repository<StudioRelease>,
    @InjectRepository(StudioTrack)
    private readonly tracks: Repository<StudioTrack>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(Listing)
    private readonly listings: Repository<Listing>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly publicReads: SubprofilePublicReadService,
    private readonly catalog: StudioCatalogService,
    private readonly madeFor: CreatorDraftMadeForService,
  ) {}

  /**
   * The wire rows in the order given. A union row whose record went between
   * the union read and this one is left out.
   */
  async rowsFor(
    unionRows: readonly CreatorDraftUnionRow[],
  ): Promise<AdminCreatorDraftRow[]> {
    if (unionRows.length === 0) return [];
    const idsByKind = new Map<CreatorDraftKind, string[]>();
    for (const unionRow of unionRows) {
      const kindIds = idsByKind.get(unionRow.kind) ?? [];
      kindIds.push(unionRow.id);
      idsByKind.set(unionRow.kind, kindIds);
    }
    const ownerIds = uniqueValues(
      unionRows.map((unionRow) => unionRow.owner_user_id),
    );
    const [loadedEntries, ownerRefs] = await Promise.all([
      Promise.all(
        [...idsByKind].map(
          async ([kind, kindIds]) =>
            [kind, await this.loadKind(kind, kindIds)] as const,
        ),
      ),
      new MemberLookup(this.profiles).byUserIds(ownerIds),
    ]);
    const loadedByKind = new Map(loadedEntries);
    const rows: AdminCreatorDraftRow[] = [];
    for (const unionRow of unionRows) {
      const loaded = loadedByKind.get(unionRow.kind)?.get(unionRow.id);
      if (!loaded) continue;
      const memberRef = ownerRefs.get(unionRow.owner_user_id);
      const row: AdminCreatorDraftRow = {
        kind: unionRow.kind,
        id: unionRow.id,
        title: loaded.fields.title,
        madeFor: loaded.fields.madeFor,
        owner: memberRef
          ? { userId: unionRow.owner_user_id, ...memberRef }
          : null,
        lastSavedAt: new Date(unionRow.last_saved_at).toISOString(),
        progress: loaded.fields.progress,
        missing: loaded.fields.missing,
      };
      this.sources.set(row, loaded.source);
      rows.push(row);
    }
    return rows;
  }

  /**
   * The row plus its allow-listed preview; null when the preview cannot be
   * built. The row must come from `rowsFor` over a union read narrowed by id,
   * which holds the scope (expiry, notice date, author status, made-for); a
   * row from anywhere else answers null with no read.
   */
  async detailFor(
    row: AdminCreatorDraftRow,
  ): Promise<AdminCreatorDraftDetail | null> {
    const source = this.sources.get(row);
    if (!source || source.kind !== row.kind) return null;
    switch (source.kind) {
      case 'persona': {
        const preview = await this.publicReads.getDraftPreviewForStaff(row.id);
        return preview ? { ...row, kind: 'persona', preview } : null;
      }
      case 'studio_release': {
        const preview = await this.studioPreviewOrNull(() =>
          this.catalog.getReleaseAsStaffDraftPreview(row.id),
        );
        return preview ? { ...row, kind: 'studio_release', preview } : null;
      }
      case 'studio_episode': {
        const preview = await this.studioPreviewOrNull(() =>
          this.catalog.getReleaseAsStaffDraftPreview(source.releaseId, row.id),
        );
        return preview
          ? { ...row, kind: 'studio_episode', preview, episodeTrackId: row.id }
          : null;
      }
      case 'listing':
        return {
          ...row,
          kind: 'listing',
          preview: toListingDraftPreview({
            draft: readListingWizardState(source.payload),
          }),
        };
      case 'event': {
        const refs = await this.madeFor.resolveEventRefs(
          source.authorUserId,
          source.payload,
        );
        const preview = toEventDraftPreview(source.payload, {
          community: toSlugAndName(refs.community),
          runByListing: toSlugAndName(refs.runByListing),
        });
        return {
          ...row,
          kind: 'event',
          preview: {
            ...preview,
            runByListing: await this.runByListingPreview(refs.runByListing),
          },
        };
      }
      case 'listing_edit':
        return {
          ...row,
          kind: 'listing_edit',
          preview: toListingDraftPreview(source.payload),
          listing: { ...source.listing },
        };
      case 'community':
        return {
          ...row,
          kind: 'community',
          preview: toCommunityDraftPreview(source.payload),
        };
    }
  }

  /** The run-by listing as staff see it; a listing that is not live has no page, so its slug reads null. */
  private async runByListingPreview(
    runByListing: DraftRef | null,
  ): Promise<{ slug: string | null; name: string } | null> {
    if (!runByListing) return null;
    const listing = (await this.findListingsById([runByListing.id])).get(
      runByListing.id,
    );
    return {
      slug: listing ? liveListingSlug(listing) : null,
      name: runByListing.name,
    };
  }

  /** The release or the episode can go between the union read and the preview. */
  private async studioPreviewOrNull(
    readPreview: () => Promise<StudioReleaseResponse>,
  ): Promise<StudioReleaseResponse | null> {
    try {
      return await readPreview();
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  private loadKind(kind: CreatorDraftKind, ids: string[]): Promise<LoadedRows> {
    switch (kind) {
      case 'persona':
        return this.loadPersonas(ids);
      case 'studio_release':
        return this.loadReleases(ids);
      case 'studio_episode':
        return this.loadEpisodes(ids);
      case 'listing':
        return this.loadListingWizardDrafts(ids);
      case 'event':
        return this.loadEventDrafts(ids);
      case 'listing_edit':
        return this.loadListingEditDrafts(ids);
      case 'community':
        return this.loadCommunityDrafts(ids);
    }
  }

  /**
   * One gap check for the page, over the personas still in scope; the
   * persona row is made for the persona itself, with no link.
   */
  private async loadPersonas(ids: string[]): Promise<LoadedRows> {
    const found = await this.subprofiles.find({ where: { id: In(ids) } });
    const personas = found.filter(isPersonaDraftInScope);
    const gapsByPersonaId =
      await this.publicReads.draftPublishGapsForStaff(personas);
    const loaded: LoadedRows = new Map();
    for (const persona of personas) {
      loaded.set(persona.id, {
        fields: {
          title: readTitle(persona.displayName),
          madeFor: {
            kind: 'persona',
            name: persona.displayName,
            slug: null,
          },
          progress: null,
          missing: [...(gapsByPersonaId.get(persona.id) ?? [])],
        },
        source: { kind: 'persona' },
      });
    }
    return loaded;
  }

  /** Releases with their persona, and every track of the page in one read. */
  private async loadReleases(ids: string[]): Promise<LoadedRows> {
    const [releases, releaseTracks] = await Promise.all([
      this.releases.find({
        where: { id: In(ids) },
        relations: { subprofile: true },
      }),
      this.tracks.find({
        where: { releaseId: In(ids) },
        select: {
          id: true,
          releaseId: true,
          audioKey: true,
          durationSeconds: true,
          sources: true,
        },
      }),
    ]);
    const tracksByReleaseId = new Map<string, StudioTrack[]>();
    for (const track of releaseTracks) {
      const tracksOfRelease = tracksByReleaseId.get(track.releaseId) ?? [];
      tracksOfRelease.push(track);
      tracksByReleaseId.set(track.releaseId, tracksOfRelease);
    }
    const loaded: LoadedRows = new Map();
    for (const release of releases) {
      if (
        !release.subprofile ||
        (release.status !== StudioReleaseStatus.Draft &&
          release.status !== StudioReleaseStatus.Scheduled)
      ) {
        continue;
      }
      loaded.set(release.id, {
        fields: {
          title: readTitle(release.title),
          madeFor: studioMadeFor(release.subprofile),
          progress: null,
          missing: unmetPublishRequirements(
            release,
            tracksByReleaseId.get(release.id) ?? [],
          ),
        },
        source: { kind: 'studio_release' },
      });
    }
    return loaded;
  }

  /** Episodes with their show and its persona, in one read. */
  private async loadEpisodes(ids: string[]): Promise<LoadedRows> {
    const episodes = await this.tracks.find({
      where: { id: In(ids) },
      relations: { release: { subprofile: true } },
    });
    const loaded: LoadedRows = new Map();
    for (const episode of episodes) {
      const persona = episode.release?.subprofile;
      if (!persona) continue;
      loaded.set(episode.id, {
        fields: {
          title: readTitle(episode.title),
          madeFor: studioMadeFor(persona),
          progress: null,
          missing: null,
        },
        source: { kind: 'studio_episode', releaseId: episode.releaseId },
      });
    }
    return loaded;
  }

  private async loadListingWizardDrafts(ids: string[]): Promise<LoadedRows> {
    const drafts = await this.listingDrafts.find({ where: { id: In(ids) } });
    const loaded: LoadedRows = new Map();
    for (const draft of drafts) {
      loaded.set(draft.id, {
        fields: {
          title: readTitle(readListingWizardState(draft.payload).name),
          madeFor: null,
          progress: listingWizardProgress(draft.payload),
          missing: null,
        },
        source: { kind: 'listing', payload: draft.payload },
      });
    }
    return loaded;
  }

  /**
   * Made for the stored community, else the stored listing. The ids were
   * checked against the author on save; the event author is the row's
   * `user_id`, the union's `owner_user_id`.
   */
  private async loadEventDrafts(ids: string[]): Promise<LoadedRows> {
    const drafts = await this.findStoredDrafts('event', ids);
    const communityIds = uniqueValues(
      drafts.map((draft) => draft.madeForCommunityId),
    );
    const [communities, listingsById] = await Promise.all([
      communityIds.length > 0
        ? this.communities.find({
            where: { id: In(communityIds) },
            select: { id: true, slug: true, name: true, archivedAt: true },
          })
        : Promise.resolve<Community[]>([]),
      this.findListingsById(
        uniqueValues(drafts.map((draft) => draft.madeForListingId)),
      ),
    ]);
    const communitiesById = new Map(
      communities.map((community) => [community.id, community]),
    );
    const loaded: LoadedRows = new Map();
    for (const draft of drafts) {
      const community = draft.madeForCommunityId
        ? communitiesById.get(draft.madeForCommunityId)
        : undefined;
      const listing = draft.madeForListingId
        ? listingsById.get(draft.madeForListingId)
        : undefined;
      const madeFor: CreatorDraftMadeFor | null = community
        ? {
            kind: 'community',
            name: community.name,
            slug: community.archivedAt ? null : community.slug,
          }
        : listing
          ? listingMadeFor(listing)
          : null;
      loaded.set(draft.id, {
        fields: {
          title: readTitle(draft.payload.title),
          madeFor,
          progress: storedProgress(draft),
          missing: storedMissing(draft),
        },
        source: {
          kind: 'event',
          payload: draft.payload,
          authorUserId: draft.userId,
        },
      });
    }
    return loaded;
  }

  /** A listing edit whose listing went is unreachable, so it is left out. */
  private async loadListingEditDrafts(ids: string[]): Promise<LoadedRows> {
    const drafts = await this.findStoredDrafts('listing_edit', ids);
    const listingsById = await this.findListingsById(
      uniqueValues(drafts.map((draft) => draft.madeForListingId)),
    );
    const loaded: LoadedRows = new Map();
    for (const draft of drafts) {
      const listing = draft.madeForListingId
        ? listingsById.get(draft.madeForListingId)
        : undefined;
      if (!listing) continue;
      loaded.set(draft.id, {
        fields: {
          title:
            readTitle(readDraftEnvelope(draft.payload).name) ??
            readTitle(listing.name),
          madeFor: listingMadeFor(listing),
          progress: storedProgress(draft),
          missing: storedMissing(draft),
        },
        source: {
          kind: 'listing_edit',
          payload: draft.payload,
          listing: {
            ref: listing.ref,
            slug: liveListingSlug(listing),
            name: listing.name,
          },
        },
      });
    }
    return loaded;
  }

  private async loadCommunityDrafts(ids: string[]): Promise<LoadedRows> {
    const drafts = await this.findStoredDrafts('community', ids);
    const loaded: LoadedRows = new Map();
    for (const draft of drafts) {
      loaded.set(draft.id, {
        fields: {
          title: readTitle(readDraftEnvelope(draft.payload).name),
          madeFor: null,
          progress: storedProgress(draft),
          missing: storedMissing(draft),
        },
        source: { kind: 'community', payload: draft.payload },
      });
    }
    return loaded;
  }

  private findStoredDrafts(
    kind: StoredCreatorDraftKind,
    ids: string[],
  ): Promise<CreatorDraft[]> {
    return this.creatorDrafts.find({ where: { id: In(ids), kind } });
  }

  private async findListingsById(
    listingIds: string[],
  ): Promise<Map<string, ListingSummary>> {
    if (listingIds.length === 0) return new Map();
    const found = await this.listings.find({
      where: { id: In(listingIds) },
      select: { id: true, ref: true, slug: true, name: true, status: true },
    });
    return new Map(found.map((listing) => [listing.id, listing]));
  }
}
