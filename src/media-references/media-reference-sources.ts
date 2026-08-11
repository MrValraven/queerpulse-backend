import type { DataSource, ObjectLiteral } from 'typeorm';
import { In } from 'typeorm';
import type {
  MediaReference,
  MediaReferenceType,
} from './media-reference.types';
import { Profile } from '../users/entities/profile.entity';
import { WorkItem } from '../profiles/entities/work-item.entity';
import { MagazineIssue } from '../magazine/entities/magazine-issue.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Event } from '../events/entities/event.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofileItem } from '../subprofiles/entities/subprofile-item.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import { CinemaTitle } from '../cinema/entities/cinema-title.entity';
import { Landlord } from '../landlords/entities/landlord.entity';
import { MagazineAuthor } from '../magazine/entities/magazine-author.entity';
import { Changemaker } from '../changemakers/entities/changemaker.entity';
import { Collection } from '../collections/entities/collection.entity';
import { Listing } from '../listings/entities/listing.entity';
import { Company } from '../companies/entities/company.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';

const FILES_PREFIX = '/files/';

/** A stored reference may be the raw storage key (`avatars/<id>/x.jpg`) or a
 * `/files/<key>` URL. Normalises either form to the bare key. */
export function toBareKey(value: string): string {
  return value.startsWith(FILES_PREFIX)
    ? value.slice(FILES_PREFIX.length)
    : value;
}

/** Both stored forms a bare key can appear as in a column. */
export function storedForms(bareKeys: string[]): string[] {
  return bareKeys.flatMap((bareKey) => [bareKey, `${FILES_PREFIX}${bareKey}`]);
}

export interface MediaReferenceSource {
  type: MediaReferenceType;
  /** DTO/entity identity used by the coverage tripwire, e.g. 'Profile.avatarUrl'. */
  field: string;
  /** Runs one bounded query; returns [bareKey, reference] pairs for matches. */
  resolve(
    dataSource: DataSource,
    candidateBareKeys: Set<string>,
    candidateStoredForms: string[],
  ): Promise<Array<[string, MediaReference]>>;
}

/** Builds a plain-column source: one entity, one string column holding a ref. */
function plainSource(config: {
  type: MediaReferenceType;
  field: string;
  entity: new () => ObjectLiteral;
  column: string; // property name holding the ref, e.g. 'avatarUrl'
  idColumn: string; // property name of the row id, e.g. 'id' | 'userId'
  labelColumns: string[]; // property names concatenated (space-joined, trimmed) for label
  slugColumn?: string; // optional property name for slug
}): MediaReferenceSource {
  return {
    type: config.type,
    field: config.field,
    async resolve(dataSource, _candidateBareKeys, candidateStoredForms) {
      if (candidateStoredForms.length === 0) return [];
      const repository = dataSource.getRepository(config.entity);
      const selectColumns = [
        config.idColumn,
        config.column,
        ...config.labelColumns,
        ...(config.slugColumn ? [config.slugColumn] : []),
      ];
      const rows = await repository.find({
        where: { [config.column]: In(candidateStoredForms) },
        select: [...new Set(selectColumns)] as never,
      });
      return rows.map((row) => {
        const bareKey = toBareKey(String(row[config.column]));
        const label = config.labelColumns
          .map((labelColumn) => String(row[labelColumn] ?? ''))
          .join(' ')
          .trim();
        const reference: MediaReference = {
          type: config.type,
          entityId: String(row[config.idColumn]),
          label,
          ...(config.slugColumn
            ? { slug: String(row[config.slugColumn] ?? '') }
            : {}),
        };
        return [bareKey, reference] as [string, MediaReference];
      });
    },
  };
}

export const PLAIN_MEDIA_REFERENCE_SOURCES: MediaReferenceSource[] = [
  plainSource({
    type: 'profile-photo',
    field: 'Profile.avatarUrl',
    entity: Profile,
    column: 'avatarUrl',
    idColumn: 'userId',
    labelColumns: ['firstName', 'lastName'],
    slugColumn: 'slug',
  }),
  plainSource({
    type: 'showcase',
    field: 'WorkItem.imageUrl',
    entity: WorkItem,
    column: 'imageUrl',
    idColumn: 'id',
    labelColumns: ['title'],
  }),
  plainSource({
    type: 'story-cover',
    field: 'MagazineIssue.coverUrl',
    entity: MagazineIssue,
    column: 'coverUrl',
    idColumn: 'id',
    labelColumns: ['title'],
    // No slug column on MagazineIssue — label-only reference on the frontend.
  }),
  plainSource({
    type: 'event-photo',
    field: 'EventPhoto.storageKey',
    entity: EventPhoto,
    column: 'storageKey',
    idColumn: 'id',
    labelColumns: [],
  }),
  plainSource({
    type: 'event-cover',
    field: 'Event.coverImageUrl',
    entity: Event,
    column: 'coverImageUrl',
    idColumn: 'id',
    labelColumns: ['title'],
    slugColumn: 'slug',
  }),
  plainSource({
    type: 'group-avatar',
    field: 'Conversation.avatarUrl',
    entity: Conversation,
    column: 'avatarUrl',
    idColumn: 'id',
    labelColumns: ['title'],
  }),
  plainSource({
    type: 'persona-avatar',
    field: 'Subprofile.avatarUrl',
    entity: Subprofile,
    column: 'avatarUrl',
    idColumn: 'id',
    labelColumns: ['displayName'],
    slugColumn: 'slug',
  }),
  plainSource({
    type: 'persona-cover',
    field: 'Subprofile.coverUrl',
    entity: Subprofile,
    column: 'coverUrl',
    idColumn: 'id',
    labelColumns: ['displayName'],
    slugColumn: 'slug',
  }),
  plainSource({
    type: 'community-post',
    field: 'CommunityPost.image',
    entity: CommunityPost,
    column: 'image',
    idColumn: 'id',
    labelColumns: [],
  }),
  plainSource({
    type: 'community-cover',
    field: 'Community.coverImageUrl',
    entity: Community,
    column: 'coverImageUrl',
    idColumn: 'id',
    labelColumns: ['name'],
    slugColumn: 'slug',
  }),
  plainSource({
    type: 'cinema-cover',
    field: 'CinemaTitle.coverImageUrl',
    entity: CinemaTitle,
    column: 'coverImageUrl',
    idColumn: 'id',
    labelColumns: ['title'],
    // No slug column on CinemaTitle — label-only reference on the frontend.
  }),
  plainSource({
    type: 'landlord',
    field: 'Landlord.photo',
    entity: Landlord,
    column: 'photo',
    idColumn: 'id',
    labelColumns: ['name'],
    slugColumn: 'slug',
  }),
  plainSource({
    type: 'magazine-author',
    field: 'MagazineAuthor.avatarUrl',
    entity: MagazineAuthor,
    column: 'avatarUrl',
    idColumn: 'id',
    labelColumns: ['name'],
    slugColumn: 'slug',
  }),
  plainSource({
    type: 'changemaker',
    field: 'Changemaker.imageUrl',
    entity: Changemaker,
    column: 'imageUrl',
    idColumn: 'id',
    labelColumns: ['name'],
    slugColumn: 'slug',
  }),
  plainSource({
    type: 'collection',
    field: 'Collection.cover',
    entity: Collection,
    column: 'cover',
    idColumn: 'id',
    labelColumns: ['name'],
    // `cover` is a varchar "cover colour/image key" — it CAN hold an upload
    // key. No slug column on Collection — label-only reference on the
    // frontend (it is owner-scoped and has no public route regardless).
  }),
];

// --- persona-item — SPECIAL source, not the generic plainSource. ---------
// `SubprofileItem.imageUrl` matches, but the item row has no persona slug of
// its own — the reference must LINK to the PARENT persona (`/p/<slug>`). So
// this source resolves matching items first, then looks up the parent
// `Subprofile` rows (there is no ORM relation between the two entities) and
// returns the PARENT persona's id as `entityId` (not the item's own id) so
// the link resolves. Two bounded queries, both `In(...)`, done in JS rather
// than a raw-SQL join to avoid relying on query-builder alias translation.
const PERSONA_ITEM_SOURCE: MediaReferenceSource = {
  type: 'persona-item',
  field: 'SubprofileItem.imageUrl',
  async resolve(dataSource, _candidateBareKeys, candidateStoredForms) {
    if (candidateStoredForms.length === 0) return [];
    const subprofileItemRepository = dataSource.getRepository(SubprofileItem);
    const matchingItems = await subprofileItemRepository.find({
      where: { imageUrl: In(candidateStoredForms) },
      select: ['imageUrl', 'title', 'subprofileId'],
    });
    if (matchingItems.length === 0) return [];

    const parentSubprofileIds = [
      ...new Set(matchingItems.map((item) => item.subprofileId)),
    ];
    const subprofileRepository = dataSource.getRepository(Subprofile);
    const parentSubprofiles = await subprofileRepository.find({
      where: { id: In(parentSubprofileIds) },
      select: ['id', 'slug'],
    });
    const parentSlugById = new Map(
      parentSubprofiles.map((subprofile) => [subprofile.id, subprofile.slug]),
    );

    return matchingItems.map((item) => {
      const bareKey = toBareKey(String(item.imageUrl));
      const reference: MediaReference = {
        type: 'persona-item',
        entityId: item.subprofileId,
        label: item.title ?? '',
        slug: parentSlugById.get(item.subprofileId) ?? '',
      };
      return [bareKey, reference] as [string, MediaReference];
    });
  },
};

/** Storage refs found in one row's structured column. Implement per source. */
type ExtractRefs = (row: ObjectLiteral) => string[];

/** Builds a structured (jsonb/array) source: prefilter with a LIKE ANY, then
 * attribute exact membership in JS against the candidate stored forms — LIKE
 * is a coarse prefilter only, never the source of a match. */
function arraySource(config: {
  type: MediaReferenceType;
  field: string;
  entity: new () => ObjectLiteral;
  column: string; // jsonb/array column, e.g. 'photos' | 'work' | 'gallery'
  idColumn: string;
  labelColumns: string[];
  slugColumn?: string;
  extractRefs: ExtractRefs;
}): MediaReferenceSource {
  return {
    type: config.type,
    field: config.field,
    async resolve(dataSource, candidateBareKeys, candidateStoredForms) {
      if (candidateBareKeys.size === 0) return [];
      const repository = dataSource.getRepository(config.entity);
      const patterns = [...candidateBareKeys].map((bareKey) => `%${bareKey}%`);
      const tableAlias = repository.metadata.tableName;
      // Prefilter: rows whose column text mentions any candidate bare key.
      const rows = await repository
        .createQueryBuilder(tableAlias)
        .where(`${tableAlias}.${config.column}::text LIKE ANY(:patterns)`, {
          patterns,
        })
        .getMany();
      const storedFormSet = new Set(candidateStoredForms);
      const pairs: Array<[string, MediaReference]> = [];
      for (const row of rows) {
        const label = config.labelColumns
          .map((labelColumn) => String(row[labelColumn] ?? ''))
          .join(' ')
          .trim();
        for (const rawRef of config.extractRefs(row)) {
          if (!storedFormSet.has(rawRef)) continue; // exact, no false positives
          const bareKey = toBareKey(rawRef);
          if (!candidateBareKeys.has(bareKey)) continue;
          pairs.push([
            bareKey,
            {
              type: config.type,
              entityId: String(row[config.idColumn]),
              label,
              ...(config.slugColumn
                ? { slug: String(row[config.slugColumn] ?? '') }
                : {}),
            },
          ]);
        }
      }
      return pairs;
    },
  };
}

export const ARRAY_MEDIA_REFERENCE_SOURCES: MediaReferenceSource[] = [
  arraySource({
    type: 'listing',
    field: 'Listing.photos',
    entity: Listing,
    column: 'photos',
    idColumn: 'id',
    labelColumns: ['name'],
    slugColumn: 'slug',
    // `Listing.photos` is a flat `{ wide, d1, d2, vibe }` jsonb map — the
    // sibling `alt` column holds alt text, not storage refs, and is
    // intentionally not read here.
    extractRefs: (row) =>
      Object.values((row.photos ?? {}) as Record<string, unknown>).filter(
        (value): value is string => typeof value === 'string',
      ),
  }),
  arraySource({
    type: 'company-work',
    field: 'Company.work[].imageUrl',
    entity: Company,
    column: 'work',
    idColumn: 'id',
    labelColumns: ['nameText'],
    slugColumn: 'slug',
    extractRefs: (row) =>
      ((row.work ?? []) as Array<{ imageUrl?: unknown }>)
        .map((workItem) => workItem?.imageUrl)
        .filter((value): value is string => typeof value === 'string'),
  }),
  arraySource({
    type: 'housing',
    field: 'HousingListing.gallery',
    entity: HousingListing,
    column: 'gallery',
    idColumn: 'id',
    labelColumns: ['title'],
    slugColumn: 'slug',
    extractRefs: (row) =>
      ((row.gallery ?? []) as unknown[]).filter(
        (value): value is string => typeof value === 'string',
      ),
  }),
];

export const MEDIA_REFERENCE_SOURCES: MediaReferenceSource[] = [
  ...PLAIN_MEDIA_REFERENCE_SOURCES,
  PERSONA_ITEM_SOURCE,
  ...ARRAY_MEDIA_REFERENCE_SOURCES,
];

/** `@IsImageReference` DTO fields that intentionally have NO resolver source
 *  because they cannot hold an upload key (external https URLs / colour tokens
 *  / editorial-only content blocks). Anything appearing in the codebase as an
 *  image field but absent from BOTH MEDIA_REFERENCE_SOURCES and this list
 *  fails the coverage tripwire (`media-reference-source-coverage.spec.ts`). */
export const RULED_OUT_IMAGE_FIELDS: string[] = [
  'MagazineDeck.cover',
  'MagazineDeck.slides',
  'MagazineArticle.blocks',
  'MagazineArticleVersion.blocks',
  'Partner.logo',
  'PressContact.avatarUrl',
];
