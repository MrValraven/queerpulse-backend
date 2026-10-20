import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { DataSource } from 'typeorm';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofileItem } from '../subprofiles/entities/subprofile-item.entity';
import {
  MEDIA_REFERENCE_SOURCES,
  RULED_OUT_IMAGE_FIELDS,
} from './media-reference-sources';

/**
 * The completeness tripwire: every `@IsImageReference` DTO field discovered
 * under `src/**\/dto/*.ts` must map (via `DTO_FIELD_TO_SOURCE_FIELD` below) to
 * either a wired `MediaReferenceSource` in `MEDIA_REFERENCE_SOURCES` or an
 * explicit `RULED_OUT_IMAGE_FIELDS` entry. A brand-new image-upload field with
 * neither fails this test — that is the point: it forces the resolver (or the
 * allowlist) to be updated in the SAME change that adds the field, so
 * "no references" stays a safe signal to delete on.
 *
 * Maintained by hand alongside the DTOs (small, deliberately not derived from
 * anything mechanical) — key is `<DtoClassName>.<propertyName>` as it appears
 * in the DTO source, value is the `field` string of the `MediaReferenceSource`
 * (or `RULED_OUT_IMAGE_FIELDS` entry) that owns the underlying entity column.
 */
const DTO_FIELD_TO_SOURCE_FIELD: Record<string, string> = {
  'CreateTitleDto.coverImageUrl': 'CinemaTitle.coverImageUrl',
  'CreateHousingListingDto.gallery': 'HousingListing.gallery',
  'UpdateHousingListingDto.gallery': 'HousingListing.gallery',
  'CreatePostDto.image': 'CommunityPost.image',
  'UpdatePostDto.image': 'CommunityPost.image',
  // A flat/global post is a `CommunityPost` row with a null `communityId`, so
  // its image lives in the same column the nested route writes.
  'UpdateFlatPostDto.image': 'CommunityPost.image',
  // Forum image upload (SOC-13). The forum's own update DTO is
  // `UpdateForumPostDto`, deliberately NOT `UpdatePostDto`: this map is keyed
  // by class name alone, so two DTOs sharing a name would collapse into one
  // entry and silently mis-map one of them.
  'CreateThreadDto.image': 'ForumPost.image',
  'ReplyThreadDto.image': 'ForumPost.image',
  'UpdateForumPostDto.image': 'ForumPost.image',
  // The forum composer's gallery. One DTO carries every photo on the opening
  // post, on a reply and on an edit, so the single entry covers all three
  // bodies — and it maps to its OWN source, not to `ForumPost.image`: the rows
  // and the legacy column are different storage that has to be collectible
  // independently.
  'ForumPostPhotoDto.image': 'ForumPostPhoto.storageKey',
  'CreateCommunityDto.coverImageUrl': 'Community.coverImageUrl',
  'CreateCommunityDto.avatarImageUrl': 'Community.avatarImageUrl',
  'UpsertCardProgramDto.crestMediaKey': 'CommunityCard.crestMediaKey',
  'UpsertCardProgramDto.backgroundMediaKey': 'CommunityCard.backgroundMediaKey',
  'CreateLandlordDto.photo': 'Landlord.photo',
  'UpdateLandlordDto.photo': 'Landlord.photo',
  // A member's own photo on a review, written by both the create and the edit
  // body. Same underlying column, so both map to the one source.
  'CreateListingReviewDto.photo': 'ListingReview.photo',
  // The ordered gallery: one `@IsImageReference` field per photo.
  'ListingGalleryPhotoDto.image': 'Listing.photoGallery',
  // LEGACY four-slot pair, still accepted on the wire. Whatever a client sends
  // through these slots is stored in the ordered gallery (the `photos` column
  // is only a derived mirror of it), so the gallery source is what covers them.
  'ListingPhotoSetDto.wide': 'Listing.photoGallery',
  'ListingPhotoSetDto.d1': 'Listing.photoGallery',
  'ListingPhotoSetDto.d2': 'Listing.photoGallery',
  'ListingPhotoSetDto.vibe': 'Listing.photoGallery',
  // The menu's PDF or photo. Its own source, so a menu file is kept alive by
  // the menu alone.
  'ListingMenuFileDto.url': 'Listing.menu.file',
  // "In the shop": one photo per shop item, an ordinary listing photo upload.
  // Its own source, so a photo moved from the gallery into a shop item stays
  // referenced.
  'ListingShopItemPhotoDto.image': 'Listing.shopItems[].photo.image',
  // The owner's card cover. Its own source, so a cover kept out of the
  // gallery stays referenced.
  'ListingCoverPhotoDto.image': 'Listing.coverPhoto.image',
  'UpdateSubprofileDTO.avatarUrl': 'Subprofile.avatarUrl',
  'UpdateSubprofileDTO.coverUrl': 'Subprofile.coverUrl',
  'SubprofileItemInputDTO.imageUrl': 'SubprofileItem.imageUrl',
  // Validated in SubprofilesService, so the walk above
  // cannot find them; the 'Persona item nested photos' describe asserts both.
  'SubprofileItemInputDTO.structured.coverUp.beforeImageUrl':
    'SubprofileItem.structured',
  'SubprofileItemInputDTO.structured.sessions[].imageUrl':
    'SubprofileItem.structured',
  'WorkItemDto.imageUrl': 'WorkItem.imageUrl',
  'UpdateProfileDto.avatarUrl': 'Profile.avatarUrl',
  'CreateEventDto.coverImageUrl': 'Event.coverImageUrl',
  'CreateGroupConversationDto.avatarUrl': 'Conversation.avatarUrl',
  'UpdateConversationDto.avatarUrl': 'Conversation.avatarUrl',
  'CompanyWorkItemDto.imageUrl': 'Company.work[].imageUrl',
  'CreateChangemakerDto.imageUrl': 'Changemaker.imageUrl',
  'UpdateArticleDto.heroImageKey': 'MagazineArticle.heroImageKey',
  'UpdateArticleDto.socialImage': 'MagazineArticle.socialImage',
  'UpdateCoverDto.coverUrl': 'MagazineIssue.coverUrl',
  // Pre-existing gap, unrelated to section 5: the `MagazineAuthor.avatarUrl`
  // source has been wired the whole time, only this mapping was absent, so the
  // tripwire above was already red. Nothing caught it because CI has never run.
  'UpdateAuthorDto.avatarUrl': 'MagazineAuthor.avatarUrl',
  'CreateStorySubmissionDto.coverImageKey':
    'MagazineStorySubmission.coverImageKey',
  'CreateDeckDto.cover': 'MagazineDeck.cover',
  // ENG-46. `avatarUrl` was `@IsUrl()`, which refused a bare storage key, so an
  // uploaded press-contact avatar could not be saved at all. Now that it can be,
  // the column needs a real source: `PressContact.avatarUrl` used to sit in
  // `RULED_OUT_IMAGE_FIELDS`, which would have let storage maintenance collect a
  // live press-kit avatar. Both bodies write the same column, so both map to the
  // one source.
  'CreatePressContactDto.avatarUrl': 'PressContact.avatarUrl',
  'UpdatePressContactDto.avatarUrl': 'PressContact.avatarUrl',
  // ENG-47. Collections are deprecated (superseded by `SavedList`) but their
  // write endpoints stay mounted, so `cover` still accepts member input. The
  // `Collection.cover` source was already wired; only the DTO mapping was
  // missing, because the fields were plain `@IsString()` until now.
  'CreateCollectionDto.cover': 'Collection.cover',
  'UpdateCollectionDto.cover': 'Collection.cover',
  // The admin Sticker Pack Builder's upload, validated the same way every
  // other required image slot is (see `ForumPostPhotoDto.image`). The source
  // was wired in an earlier task; this entry is the one this DTO needed.
  'CreateStickerDto.storageKey': 'Sticker.storageKey',
  'UpdateStudioReleaseDto.coverKey': 'StudioRelease.coverKey',
  // Studio v3 persona posts: the create and the edit body both write the
  // one photo column.
  'CreatePersonaPostDto.imageKey': 'SubprofilePost.imageKey',
  'UpdatePersonaPostDto.imageKey': 'SubprofilePost.imageKey',
  // Pulse Live: one image per quiz question, written by the quiz PUT and
  // copied by an event import. The source also reads an open session's
  // frozen quiz snapshot.
  'QuizshowQuestionInputDto.mediaRef': 'QuizshowQuestion.mediaRef',
};

/** Recursively lists every `.ts` file under a `dto/` directory beneath `root`
 *  (excluding `.spec.ts`). Walks the whole `src` tree looking for `dto`
 *  directories rather than assuming a fixed depth, since feature modules
 *  nest `dto/` directly under `src/<feature>/dto/`. */
function listDtoFiles(root: string): string[] {
  const dtoFiles: string[] = [];
  const directoryEntries = readdirSync(root, { withFileTypes: true });
  for (const directoryEntry of directoryEntries) {
    const entryPath = join(root, directoryEntry.name);
    if (directoryEntry.isDirectory()) {
      if (directoryEntry.name === 'node_modules') continue;
      if (directoryEntry.name === 'dto') {
        const dtoDirectoryEntries = readdirSync(entryPath, {
          withFileTypes: true,
        });
        for (const dtoDirectoryEntry of dtoDirectoryEntries) {
          if (
            dtoDirectoryEntry.isFile() &&
            dtoDirectoryEntry.name.endsWith('.ts') &&
            !dtoDirectoryEntry.name.endsWith('.spec.ts')
          ) {
            dtoFiles.push(join(entryPath, dtoDirectoryEntry.name));
          }
        }
        continue;
      }
      dtoFiles.push(...listDtoFiles(entryPath));
    }
  }
  return dtoFiles;
}

/** Finds the `export class <Name>` that most closely precedes `matchIndex`
 *  in the same file — i.e. the class the decorated property belongs to. */
function findEnclosingClassName(
  fileContent: string,
  matchIndex: number,
): string | null {
  const classDeclarationPattern = /export class (\w+)/g;
  let enclosingClassName: string | null = null;
  let classMatch: RegExpExecArray | null;
  while ((classMatch = classDeclarationPattern.exec(fileContent)) !== null) {
    if (classMatch.index > matchIndex) break;
    const capturedClassName = classMatch[1];
    if (capturedClassName !== undefined) enclosingClassName = capturedClassName;
  }
  return enclosingClassName;
}

/** Scans every DTO file for `@IsImageReference(...)` decorators and returns
 *  the set of `<ClassName>.<propertyName>` fields they guard. */
function discoverImageReferenceFields(srcRoot: string): string[] {
  const discoveredFields = new Set<string>();
  const decoratorPattern = /@IsImageReference\([^)]*\)\s*(\w+)[?!]?\s*:/g;
  for (const dtoFilePath of listDtoFiles(srcRoot)) {
    const fileContent = readFileSync(dtoFilePath, 'utf8');
    let decoratorMatch: RegExpExecArray | null;
    decoratorPattern.lastIndex = 0;
    while ((decoratorMatch = decoratorPattern.exec(fileContent)) !== null) {
      const propertyName = decoratorMatch[1];
      if (propertyName === undefined) continue; // regex always captures group 1 on a match
      const enclosingClassName = findEnclosingClassName(
        fileContent,
        decoratorMatch.index,
      );
      if (!enclosingClassName) {
        throw new Error(
          `Found @IsImageReference on "${propertyName}" in ${dtoFilePath} with no enclosing "export class" — update the coverage-spec parser.`,
        );
      }
      discoveredFields.add(`${enclosingClassName}.${propertyName}`);
    }
  }
  return [...discoveredFields];
}

describe('media reference source coverage (tripwire)', () => {
  it('maps every @IsImageReference DTO field to a wired source or the ruled-out allowlist', () => {
    const srcRoot = join(__dirname, '..');
    const discoveredFields = discoverImageReferenceFields(srcRoot);

    // Sanity: the walker actually found DTOs — an empty result would make
    // every assertion below vacuously true and silently defeat the tripwire.
    expect(discoveredFields.length).toBeGreaterThan(0);

    const coveredSourceFields = new Set(
      MEDIA_REFERENCE_SOURCES.map((source) => source.field),
    );
    const ruledOutFields = new Set(RULED_OUT_IMAGE_FIELDS);

    for (const discoveredField of discoveredFields) {
      const mappedSourceField = DTO_FIELD_TO_SOURCE_FIELD[discoveredField];
      if (!mappedSourceField) {
        throw new Error(
          `"${discoveredField}" is a new @IsImageReference DTO field with no entry in DTO_FIELD_TO_SOURCE_FIELD (media-reference-source-coverage.spec.ts). Add one, and wire a MediaReferenceSource (or RULED_OUT_IMAGE_FIELDS entry) for it.`,
        );
      }
      const isCovered =
        coveredSourceFields.has(mappedSourceField) ||
        ruledOutFields.has(mappedSourceField);
      if (!isCovered) {
        throw new Error(
          `"${discoveredField}" maps to "${mappedSourceField}", which is neither a wired MediaReferenceSource nor a RULED_OUT_IMAGE_FIELDS entry.`,
        );
      }
    }
  });
});

describe('shop item photos', () => {
  it('are a listing reference, so the media pages name the listing they sit on', () => {
    const shopItemSource = MEDIA_REFERENCE_SOURCES.find(
      (source) => source.field === 'Listing.shopItems[].photo.image',
    );
    expect(shopItemSource?.type).toBe('listing');
  });
});

describe('Studio release covers', () => {
  it('are a studio-cover reference, so the orphan sweep and My uploads see them in use', () => {
    const coverSource = MEDIA_REFERENCE_SOURCES.find(
      (source) => source.field === 'StudioRelease.coverKey',
    );
    expect(coverSource?.type).toBe('studio-cover');
  });
});

describe('Persona post photos', () => {
  it('are a persona-post reference, so the orphan sweep and My uploads see them in use', () => {
    const postSource = MEDIA_REFERENCE_SOURCES.find(
      (source) => source.field === 'SubprofilePost.imageKey',
    );
    expect(postSource?.type).toBe('persona-post');
  });
});

describe('Persona item nested photos', () => {
  const nestedSource = MEDIA_REFERENCE_SOURCES.find(
    (source) => source.field === 'SubprofileItem.structured',
  );

  it('are a persona-item reference', () => {
    expect(nestedSource?.type).toBe('persona-item');
  });

  it('map every service-validated nested field to a wired source', () => {
    const coveredSourceFields = new Set(
      MEDIA_REFERENCE_SOURCES.map((source) => source.field),
    );
    for (const dtoField of [
      'SubprofileItemInputDTO.structured.coverUp.beforeImageUrl',
      'SubprofileItemInputDTO.structured.sessions[].imageUrl',
    ]) {
      const mappedSourceField = DTO_FIELD_TO_SOURCE_FIELD[dtoField];
      expect(mappedSourceField).toBe('SubprofileItem.structured');
      expect(coveredSourceFields.has(mappedSourceField ?? '')).toBe(true);
    }
  });

  it('resolves a session photo to its parent persona', async () => {
    const sessionKey = 'work-image/u1/s1.jpg';
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        {
          subprofileId: 'p1',
          title: 'Back piece',
          structured: { sessions: [{ imageUrl: sessionKey }] },
        },
        {
          subprofileId: 'p1',
          title: 'work-image/u1/other.jpg',
          structured: { sessions: [{ imageUrl: 'work-image/u1/other.jpg' }] },
        },
      ]),
    };
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === SubprofileItem) {
          return { createQueryBuilder: () => queryBuilder };
        }
        if (entity === Subprofile) {
          return {
            find: jest
              .fn()
              .mockResolvedValue([{ id: 'p1', handle: 'inkbyrui' }]),
          };
        }
        throw new Error('unexpected repository');
      }),
    } as unknown as DataSource;

    const resolved = await nestedSource!.resolve(
      dataSource,
      new Set([sessionKey]),
      [sessionKey, `/files/${sessionKey}`],
    );

    expect(resolved).toEqual([
      [
        sessionKey,
        {
          type: 'persona-item',
          entityId: 'p1',
          label: 'Back piece',
          slug: 'inkbyrui',
        },
      ],
    ]);
  });

  it('ignores a key that only appears in the item title', async () => {
    const titleOnlyKey = 'work-image/u1/title.jpg';
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        {
          subprofileId: 'p1',
          title: titleOnlyKey,
          structured: { sessions: [{ imageUrl: 'work-image/u1/s1.jpg' }] },
        },
      ]),
    };
    const dataSource = {
      getRepository: jest.fn(() => ({
        createQueryBuilder: () => queryBuilder,
        find: jest.fn().mockResolvedValue([{ id: 'p1', handle: 'inkbyrui' }]),
      })),
    } as unknown as DataSource;

    const resolved = await nestedSource!.resolve(
      dataSource,
      new Set([titleOnlyKey]),
      [titleOnlyKey, `/files/${titleOnlyKey}`],
    );

    expect(resolved).toEqual([]);
  });
});

describe('Pulse Live question images', () => {
  const questionSource = MEDIA_REFERENCE_SOURCES.find(
    (source) => source.field === 'QuizshowQuestion.mediaRef',
  );

  function dataSourceReturning(rows: unknown[]): {
    dataSource: DataSource;
    query: jest.Mock;
  } {
    const query = jest.fn().mockResolvedValue(rows);
    return { dataSource: { query } as unknown as DataSource, query };
  }

  it('are a quizshow-question reference', () => {
    expect(questionSource?.type).toBe('quizshow-question');
  });

  it('a quiz question image counts as in use', async () => {
    const imageKey = 'work-image/u1/caption.jpg';
    const { dataSource, query } = dataSourceReturning([
      {
        media_ref: imageKey,
        quiz_id: 'quiz-1',
        quiz_title: null,
        quiz_event_id: 'event-1',
        event_title: 'Quiz night',
        event_slug: 'quiz-night',
      },
    ]);

    const resolved = await questionSource!.resolve(
      dataSource,
      new Set([imageKey]),
      [imageKey, `/files/${imageKey}`],
    );

    expect(resolved).toEqual([
      [
        imageKey,
        {
          type: 'quizshow-question',
          entityId: 'event-1',
          label: 'Quiz night',
          slug: 'quiz-night',
        },
      ],
    ]);
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      [imageKey, `/files/${imageKey}`],
    ]);
  });

  it('counts every event whose quiz shares an imported key', async () => {
    const imageKey = 'work-image/u1/shared.jpg';
    const { dataSource } = dataSourceReturning([
      {
        media_ref: imageKey,
        quiz_id: 'quiz-1',
        quiz_title: null,
        quiz_event_id: 'event-1',
        event_title: 'First quiz night',
        event_slug: 'first-quiz-night',
      },
      {
        media_ref: `/files/${imageKey}`,
        quiz_id: 'quiz-2',
        quiz_title: null,
        quiz_event_id: 'event-2',
        event_title: 'Second quiz night',
        event_slug: 'second-quiz-night',
      },
    ]);

    const resolved = await questionSource!.resolve(
      dataSource,
      new Set([imageKey]),
      [imageKey, `/files/${imageKey}`],
    );

    expect(resolved.map(([, reference]) => reference.entityId)).toEqual([
      'event-1',
      'event-2',
    ]);
  });

  it('lists an event once when both stored forms of a key reference it', async () => {
    const imageKey = 'work-image/u1/twice.jpg';
    const { dataSource } = dataSourceReturning([
      {
        media_ref: imageKey,
        quiz_id: 'quiz-1',
        quiz_title: null,
        quiz_event_id: 'event-1',
        event_title: 'Quiz night',
        event_slug: 'quiz-night',
      },
      {
        media_ref: `/files/${imageKey}`,
        quiz_id: 'quiz-1',
        quiz_title: null,
        quiz_event_id: 'event-1',
        event_title: 'Quiz night',
        event_slug: 'quiz-night',
      },
    ]);

    const resolved = await questionSource!.resolve(
      dataSource,
      new Set([imageKey]),
      [imageKey, `/files/${imageKey}`],
    );

    expect(resolved).toHaveLength(1);
  });

  it('reads the snapshot of an open session in the same query', async () => {
    const { dataSource, query } = dataSourceReturning([]);

    await questionSource!.resolve(
      dataSource,
      new Set(['work-image/u1/live.jpg']),
      ['work-image/u1/live.jpg', '/files/work-image/u1/live.jpg'],
    );

    const [firstCall] = query.mock.calls as Array<[string, unknown[]]>;
    const sql = String(firstCall?.[0]);
    expect(sql).toContain('"quizshow_questions"');
    expect(sql).toContain('"quiz_snapshot"');
    expect(sql).toContain(
      `"session"."status" IN ('lobby', 'running', 'paused')`,
    );
  });

  it('links a game question image to the game with its title', async () => {
    const gameOwnerId = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    const imageKey = `work/${gameOwnerId}/7c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f.jpg`;
    const { dataSource, query } = dataSourceReturning([
      {
        media_ref: imageKey,
        quiz_id: 'quiz-9',
        quiz_title: 'Friday trivia',
        quiz_event_id: null,
        quiz_owner_user_id: gameOwnerId,
        event_title: null,
        event_slug: null,
      },
    ]);

    const resolved = await questionSource!.resolve(
      dataSource,
      new Set([imageKey]),
      [imageKey, `/files/${imageKey}`],
    );

    expect(resolved).toEqual([
      [
        imageKey,
        {
          type: 'quizshow-game-question',
          entityId: 'quiz-9',
          label: 'Friday trivia',
          slug: '',
        },
      ],
    ]);
    const [firstCall] = query.mock.calls as Array<[string, unknown[]]>;
    expect(String(firstCall?.[0])).toContain(
      '"quiz"."owner_user_id" AS "quiz_owner_user_id"',
    );
  });

  it("hides another member's game title from an uploader's media", async () => {
    const coHostId = '4a2b3c5d-6e7f-4a81-9b0c-1d2e3f4a5b6c';
    const gameOwnerId = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    const imageKey = `work/${coHostId}/8d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a.jpg`;
    const ownerlessKey = 'work-image/u1/ownerless.jpg';
    const { dataSource } = dataSourceReturning([
      {
        media_ref: imageKey,
        quiz_id: 'quiz-9',
        quiz_title: 'Private game title',
        quiz_event_id: null,
        quiz_owner_user_id: gameOwnerId,
        event_title: null,
        event_slug: null,
      },
      {
        media_ref: ownerlessKey,
        quiz_id: 'quiz-9',
        quiz_title: 'Private game title',
        quiz_event_id: null,
        quiz_owner_user_id: gameOwnerId,
        event_title: null,
        event_slug: null,
      },
    ]);

    const resolved = await questionSource!.resolve(
      dataSource,
      new Set([imageKey, ownerlessKey]),
      [imageKey, ownerlessKey],
    );

    expect(resolved).toEqual([
      [
        imageKey,
        {
          type: 'quizshow-game-question',
          entityId: 'quiz-9',
          label: '',
          slug: '',
        },
      ],
      [
        ownerlessKey,
        {
          type: 'quizshow-game-question',
          entityId: 'quiz-9',
          label: '',
          slug: '',
        },
      ],
    ]);
  });

  it('names an image of an open game session once per game', async () => {
    const imageKey = 'work-image/u1/open-game.jpg';
    const gameRow = {
      quiz_id: 'quiz-9',
      quiz_title: 'Friday trivia',
      quiz_event_id: null,
      event_title: null,
      event_slug: null,
    };
    const { dataSource } = dataSourceReturning([
      { media_ref: imageKey, ...gameRow },
      { media_ref: `/files/${imageKey}`, ...gameRow },
    ]);

    const resolved = await questionSource!.resolve(
      dataSource,
      new Set([imageKey]),
      [imageKey, `/files/${imageKey}`],
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.[1].entityId).toBe('quiz-9');
  });

  it('keeps an event question image on the event', async () => {
    const imageKey = 'work-image/u1/event.jpg';
    const { dataSource } = dataSourceReturning([
      {
        media_ref: imageKey,
        quiz_id: 'quiz-1',
        quiz_title: 'Quiz night quiz',
        quiz_event_id: 'event-1',
        event_title: 'Quiz night',
        event_slug: 'quiz-night',
      },
    ]);

    const resolved = await questionSource!.resolve(
      dataSource,
      new Set([imageKey]),
      [imageKey, `/files/${imageKey}`],
    );

    expect(resolved[0]?.[1]).toEqual({
      type: 'quizshow-question',
      entityId: 'event-1',
      label: 'Quiz night',
      slug: 'quiz-night',
    });
  });

  it('joins events with a left join', async () => {
    const { dataSource, query } = dataSourceReturning([]);

    await questionSource!.resolve(
      dataSource,
      new Set(['work-image/u1/a.jpg']),
      ['work-image/u1/a.jpg'],
    );

    const [firstCall] = query.mock.calls as Array<[string, unknown[]]>;
    expect(String(firstCall?.[0])).toContain('LEFT JOIN "events"');
  });

  it('runs no query for an empty candidate set', async () => {
    const { dataSource, query } = dataSourceReturning([]);

    const resolved = await questionSource!.resolve(dataSource, new Set(), []);

    expect(resolved).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('rules out the frozen snapshot of an ended session', () => {
    expect(RULED_OUT_IMAGE_FIELDS).toContain('QuizshowSession.quizSnapshot');
  });
});
