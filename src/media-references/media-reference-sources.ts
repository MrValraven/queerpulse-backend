import type { DataSource, ObjectLiteral } from 'typeorm';
import { In } from 'typeorm';
import type {
  MediaReference,
  MediaReferenceType,
} from './media-reference.types';
import { Profile } from '../users/entities/profile.entity';
import { WorkItem } from '../profiles/entities/work-item.entity';
import { MagazineArticle } from '../magazine/entities/magazine-article.entity';
import { MagazineDeck } from '../magazine/entities/magazine-deck.entity';
import { MagazineIssue } from '../magazine/entities/magazine-issue.entity';
import { Message } from '../messaging/entities/message.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Event } from '../events/entities/event.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofileItem } from '../subprofiles/entities/subprofile-item.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import {
  CardIssuerType,
  CommunityCard,
} from '../membership-cards/entities/community-card.entity';
import { CinemaTitle } from '../cinema/entities/cinema-title.entity';
import { Landlord } from '../landlords/entities/landlord.entity';
import { MagazineAuthor } from '../magazine/entities/magazine-author.entity';
import { Changemaker } from '../changemakers/entities/changemaker.entity';
import { Collection } from '../collections/entities/collection.entity';
import { Listing } from '../listings/entities/listing.entity';
import { Company } from '../companies/entities/company.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { FILES_PREFIX, toBareKey } from '../storage/bare-key';

// Re-exported so every existing importer of `toBareKey` from this module
// (and the coverage spec) keeps working unchanged. The implementation now
// lives in the entity-free `src/storage/bare-key.ts` so consumers that only
// need key normalisation (e.g. `media-crops`) don't have to pull in this
// file's ~15 entity imports.
export { toBareKey } from '../storage/bare-key';

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
    // The community's small square identity mark, a separate column from the
    // wide banner above and written by the same upload kind. Its own source
    // (rather than a second column on the cover one) because `plainSource`
    // matches exactly one column, and because the two are independently
    // deletable: an avatar with no references must not be kept alive by a
    // cover that happens to share the row.
    type: 'community-avatar',
    field: 'Community.avatarImageUrl',
    entity: Community,
    column: 'avatarImageUrl',
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
    type: 'magazine-article',
    field: 'MagazineArticle.socialImage',
    entity: MagazineArticle,
    column: 'socialImage',
    idColumn: 'id',
    labelColumns: ['title'],
    slugColumn: 'slug',
  }),
  plainSource({
    type: 'magazine-deck',
    field: 'MagazineDeck.cover',
    entity: MagazineDeck,
    column: 'cover',
    idColumn: 'id',
    labelColumns: ['title'],
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

// --- membership-card programme art — SPECIAL sources, beyond `plainSource`. -
// A `CommunityCard` row is the card PROGRAMME an issuer designs once, and it
// holds two uploads of its own: the crest printed on the card and the ground
// the card is painted on. Both were invisible to this resolver, so a crest or
// a background that is on every member's card read as "No references" in the
// media console and invited a delete that would have blanked live cards.
//
// They cannot use `plainSource` because the row carries no name or slug: its
// identity is the ISSUING community, reached through `issuerId`. So this
// resolves matching cards first, then looks up those communities (there is no
// ORM relation between the two entities) and returns the COMMUNITY's id and
// slug so the reference links to `/community/<slug>`, mirroring how
// `PERSONA_ITEM_SOURCE` links an item to its parent persona.
//
// A `collective`-issued programme has no `communities` row to resolve, so it
// comes back label- and slug-less: still a reference (the key IS in use, which
// is the part that must never be wrong), just without a link.
function cardProgramSource(config: {
  type: MediaReferenceType;
  field: string;
  column: 'crestMediaKey' | 'backgroundMediaKey';
}): MediaReferenceSource {
  return {
    type: config.type,
    field: config.field,
    async resolve(dataSource, _candidateBareKeys, candidateStoredForms) {
      if (candidateStoredForms.length === 0) return [];
      const communityCardRepository = dataSource.getRepository(CommunityCard);
      const matchingCards = await communityCardRepository.find({
        where: { [config.column]: In(candidateStoredForms) },
        select: ['id', config.column, 'issuerType', 'issuerId'],
      });
      if (matchingCards.length === 0) return [];

      const communityIssuerIds = [
        ...new Set(
          matchingCards
            .filter((card) => card.issuerType === CardIssuerType.Community)
            .map((card) => card.issuerId),
        ),
      ];
      const communityRepository = dataSource.getRepository(Community);
      const issuingCommunities =
        communityIssuerIds.length > 0
          ? await communityRepository.find({
              where: { id: In(communityIssuerIds) },
              select: ['id', 'name', 'slug'],
            })
          : [];
      const communityById = new Map(
        issuingCommunities.map((community) => [community.id, community]),
      );

      return matchingCards.map((card) => {
        const bareKey = toBareKey(String(card[config.column]));
        const issuingCommunity = communityById.get(card.issuerId);
        const reference: MediaReference = {
          type: config.type,
          // The issuing community's id: `entityId` is what the frontend links
          // on, and a card programme has no page of its own.
          entityId: issuingCommunity?.id ?? card.id,
          label: issuingCommunity?.name ?? '',
          slug: issuingCommunity?.slug ?? '',
        };
        return [bareKey, reference] as [string, MediaReference];
      });
    },
  };
}

const CARD_PROGRAM_SOURCES: MediaReferenceSource[] = [
  cardProgramSource({
    type: 'card-crest',
    field: 'CommunityCard.crestMediaKey',
    column: 'crestMediaKey',
  }),
  cardProgramSource({
    type: 'card-background',
    field: 'CommunityCard.backgroundMediaKey',
    column: 'backgroundMediaKey',
  }),
];

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
  /** Extra SQL predicate ANDed onto the prefilter, written against
   *  `<tableAlias>`. Use it to skip rows that cannot hold an upload key at all
   *  (e.g. every message that is not a photo). */
  additionalWhere?: string;
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
      const queryBuilder = repository
        .createQueryBuilder(tableAlias)
        .where(`${tableAlias}.${config.column}::text LIKE ANY(:patterns)`, {
          patterns,
        });
      if (config.additionalWhere) {
        queryBuilder.andWhere(config.additionalWhere);
      }
      const rows = await queryBuilder.getMany();
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
  arraySource({
    type: 'magazine-article',
    field: 'MagazineArticle.blocks[].src',
    entity: MagazineArticle,
    column: 'blocks',
    idColumn: 'id',
    labelColumns: ['title'],
    slugColumn: 'slug',
    // Only the `image` block kind carries a storage ref (`src`); every other
    // kind's strings are prose. A published article's photos were the largest
    // blind spot in this table — a member tidying "unused" uploads could break
    // a live piece with no warning at all.
    extractRefs: (row) =>
      ((row.blocks ?? []) as Array<{ kind?: unknown; src?: unknown }>)
        .filter((block) => block?.kind === 'image')
        .map((block) => block.src)
        .filter((value): value is string => typeof value === 'string'),
  }),
  arraySource({
    type: 'magazine-deck',
    field: 'MagazineDeck.slides[].src',
    entity: MagazineDeck,
    column: 'slides',
    idColumn: 'id',
    labelColumns: ['title'],
    slugColumn: 'slug',
    // `image` slides hold one `src`; a `before-after` interactive slide holds
    // two nested ones (`before.src`/`after.src`). Every other slide layout is
    // text or a stat.
    extractRefs: (row) =>
      ((row.slides ?? []) as Array<Record<string, unknown>>).flatMap(
        (slide) => {
          const nested = [slide.before, slide.after]
            .map((side) => (side as { src?: unknown } | undefined)?.src)
            .filter((value): value is string => typeof value === 'string');
          const src = slide.src;
          return typeof src === 'string' ? [src, ...nested] : nested;
        },
      ),
  }),
  arraySource({
    type: 'message-photo',
    field: 'Message.attachment.url',
    entity: Message,
    column: 'attachment',
    idColumn: 'conversationId',
    // A message has no title, and the conversation's does not belong in the
    // uploader's media list — the reference is deliberately label-less. It
    // exists to say "this photo is still in a conversation", nothing more.
    labelColumns: [],
    // `messages` is the largest table in the app and no index can serve a
    // `LIKE ANY` over a jsonb column, so narrow the scan to the only rows that
    // can possibly hold one of our keys: a photo message with an attachment.
    // A picked GIF stores an absolute provider URL, not a key.
    additionalWhere: `messages.attachment IS NOT NULL AND messages.kind = 'image'`,
    // A `kind:'gif'` attachment holds an absolute provider URL, never one of
    // our keys; the exact-membership check below filters those out anyway.
    // `previewUrl` is the same value as `url` for an uploaded image, but it is
    // read too so a future separate thumbnail key is not silently orphaned.
    extractRefs: (row) => {
      const attachment = row.attachment as
        { url?: unknown; previewUrl?: unknown } | null | undefined;
      // De-duplicated: for an uploaded photo `previewUrl` IS `url`, and the
      // same message must not be listed twice as two separate references.
      return [
        ...new Set(
          [attachment?.url, attachment?.previewUrl].filter(
            (value): value is string => typeof value === 'string',
          ),
        ),
      ];
    },
  }),
];

export const MEDIA_REFERENCE_SOURCES: MediaReferenceSource[] = [
  ...PLAIN_MEDIA_REFERENCE_SOURCES,
  PERSONA_ITEM_SOURCE,
  ...CARD_PROGRAM_SOURCES,
  ...ARRAY_MEDIA_REFERENCE_SOURCES,
];

/** `@IsImageReference` DTO fields that intentionally have NO resolver source
 *  because they cannot hold an upload key (external https URLs / colour tokens
 *  / editorial-only content blocks). Anything appearing in the codebase as an
 *  image field but absent from BOTH MEDIA_REFERENCE_SOURCES and this list
 *  fails the coverage tripwire (`media-reference-source-coverage.spec.ts`). */
export const RULED_OUT_IMAGE_FIELDS: string[] = [
  // `MagazineArticleVersion.blocks` is a frozen SNAPSHOT of an article's blocks
  // taken at a point in time. It is deliberately not a source: a key referenced
  // only by a superseded version is not live anywhere a reader can reach, and
  // counting history as "in use" would make every image an editor ever swapped
  // out permanently undeletable. The CURRENT blocks are covered by
  // `MagazineArticle.blocks[].src`.
  'MagazineArticleVersion.blocks',
  'Partner.logo',
  'PressContact.avatarUrl',
];
