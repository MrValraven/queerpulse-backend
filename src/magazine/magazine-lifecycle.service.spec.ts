import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CreateArticleTranslationDto } from './dto/create-article-translation.dto';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import {
  MagazinePiece,
  PieceCare,
  PieceCareSubject,
} from './entities/magazine-piece.entity';
import { MagazinePieceEvent } from './entities/magazine-piece-event.entity';
import { MagazineLifecycleService } from './magazine-lifecycle.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';

type RepositoryMock = {
  find: jest.Mock;
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeRepositoryMock(): RepositoryMock {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((entity: unknown) => entity),
    save: jest.fn((entity: unknown) => Promise.resolve(entity)),
    createQueryBuilder: jest.fn(),
  };
}

/**
 * `PieceCare.subjects[0]` reads as possibly `undefined` under
 * `noUncheckedIndexedAccess`. An explicit guard narrows it to a concrete
 * `PieceCareSubject` for the caller and fails the test with a clear message
 * if a fixture is ever missing the subject it is supposed to carry.
 */
function firstCareSubject(care: PieceCare): PieceCareSubject {
  const subject = care.subjects[0];
  if (!subject) {
    throw new Error('Expected the care fixture to carry at least one subject.');
  }
  return subject;
}

const ORIGINAL_CARE: PieceCare = {
  subjects: [
    {
      name: 'Alex Rivera',
      named: true,
      out: true,
      consent: 'given',
      reply: 'Yes, go ahead.',
      note: '',
    },
  ],
  contentNotes: ['Discusses estrangement from family.'],
  flags: [{ key: 'minors', on: false, note: '' }],
  read: {
    reader: 'Jo Martins',
    role: 'sensitivity reader',
    status: 'done',
    askedOn: '2026-07-01',
    dueOn: '2026-07-10',
    checks: [],
  },
};

function makeOriginalPiece(
  overrides: Partial<MagazinePiece> = {},
): MagazinePiece {
  return {
    id: 'piece-1',
    format: 'article',
    title: 'On chosen family',
    section: 'Features',
    kind: null,
    stage: 'published',
    editorId: 'editor-1',
    writerId: 'writer-1',
    byline: 'Kai Duarte',
    dueOn: null,
    issueId: 'issue-1',
    articleId: 'article-1',
    deckId: null,
    wordTarget: 1500,
    slideTarget: null,
    fresh: false,
    pitchId: null,
    orderIndex: null,
    pages: null,
    laidOut: false,
    art: 'none',
    contentsBlurb: '',
    brief: null,
    care: ORIGINAL_CARE,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeOriginalArticle(
  overrides: Partial<MagazineArticle> = {},
): MagazineArticle {
  return {
    id: 'article-1',
    slug: 'on-chosen-family',
    title: 'On chosen family',
    dek: '',
    body: '',
    standfirst: '',
    kicker: '',
    section: 'Features',
    role: '',
    metaDescription: '',
    socialImage: '',
    canonicalUrl: '',
    heroImageKey: '',
    contentNotes: [],
    blocks: [],
    authorId: 'author-1',
    issueId: 'issue-1',
    tags: [],
    readMinutes: 5,
    publishedAt: new Date('2026-08-05T09:00:00.000Z'),
    lifecycle: 'live',
    lifecycleNote: '',
    lifecycleChangedAt: null,
    reviewDueOn: null,
    supersededByArticleId: null,
    locale: 'en',
    translationOfArticleId: null,
    translatorAuthorId: null,
    version: 0,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('MagazineLifecycleService', () => {
  let service: MagazineLifecycleService;
  let articles: RepositoryMock;
  let authors: RepositoryMock;
  let pieces: RepositoryMock;
  let pieceEvents: RepositoryMock;
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    articles = makeRepositoryMock();
    authors = makeRepositoryMock();
    pieces = makeRepositoryMock();
    pieceEvents = makeRepositoryMock();
    notifications = { create: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MagazineLifecycleService,
        { provide: getRepositoryToken(MagazineArticle), useValue: articles },
        { provide: getRepositoryToken(MagazineAuthor), useValue: authors },
        { provide: getRepositoryToken(MagazinePiece), useValue: pieces },
        {
          provide: getRepositoryToken(MagazinePieceEvent),
          useValue: pieceEvents,
        },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get(MagazineLifecycleService);
  });

  describe('createTranslation', () => {
    /**
     * Wires the original piece/article lookups and the slug/duplicate
     * checks that every `createTranslation` call runs, so each test only
     * has to override what it cares about. Returns a getter for the
     * translation piece the service saves, captured off the `save` mock
     * directly so the read stays typed, without pulling it back through
     * `jest.Mock`'s untyped `mock.calls`.
     */
    function wireOriginal(
      piece: MagazinePiece,
      article: MagazineArticle,
    ): { getSavedPiece: () => MagazinePiece } {
      pieces.findOne.mockImplementation((query: { where: { id: string } }) => {
        if (query.where.id === piece.id) return Promise.resolve(piece);
        return Promise.resolve(null);
      });
      articles.findOne.mockImplementation(
        (query: {
          where: {
            id?: string;
            slug?: string;
            translationOfArticleId?: string;
          };
        }) => {
          if (query.where.id === article.id) return Promise.resolve(article);
          // Neither the duplicate-translation check nor the slug-uniqueness
          // check should find a collision in these fixtures.
          return Promise.resolve(null);
        },
      );
      let nextArticleId = 0;
      articles.save.mockImplementation((entity: MagazineArticle) => {
        entity.id = `article-translation-${++nextArticleId}`;
        return Promise.resolve(entity);
      });
      let nextPieceId = 0;
      let savedPiece: MagazinePiece | undefined;
      pieces.save.mockImplementation((entity: MagazinePiece) => {
        entity.id = `piece-translation-${++nextPieceId}`;
        savedPiece = entity;
        return Promise.resolve(entity);
      });
      return {
        getSavedPiece: () => savedPiece!,
      };
    }

    it("clones the original piece's care so mutating the copy leaves the original intact", async () => {
      const original = makeOriginalPiece();
      const article = makeOriginalArticle();
      const { getSavedPiece } = wireOriginal(original, article);

      const dto: CreateArticleTranslationDto = {
        locale: 'pt',
        translatorUserId: 'translator-1',
      };
      await service.createTranslation('piece-1', dto, 'editor-1');

      const savedPiece = getSavedPiece();
      expect(savedPiece.care).toEqual(ORIGINAL_CARE);
      expect(savedPiece.care).not.toBe(original.care);

      savedPiece.care!.contentNotes.push('Added after translating.');
      firstCareSubject(savedPiece.care!).consent = 'pending';

      expect(original.care!.contentNotes).toEqual([
        'Discusses estrangement from family.',
      ]);
      expect(firstCareSubject(original.care!).consent).toBe('given');
    });

    it('leaves care null when the original piece has no care record', async () => {
      const original = makeOriginalPiece({ care: null });
      const article = makeOriginalArticle();
      const { getSavedPiece } = wireOriginal(original, article);

      const dto: CreateArticleTranslationDto = {
        locale: 'pt',
        translatorUserId: 'translator-1',
      };
      await service.createTranslation('piece-1', dto, 'editor-1');

      expect(getSavedPiece().care).toBeNull();
    });

    it('notifies the translator that the job is theirs', async () => {
      const original = makeOriginalPiece();
      const article = makeOriginalArticle();
      const { getSavedPiece } = wireOriginal(original, article);

      const dto: CreateArticleTranslationDto = {
        locale: 'pt',
        translatorUserId: 'translator-1',
      };
      await service.createTranslation('piece-1', dto, 'editor-1');

      expect(notifications.create).toHaveBeenCalledWith(
        'translator-1',
        NotificationType.MagazinePieceCommissioned,
        expect.objectContaining({
          pieceId: getSavedPiece().id,
          actorId: 'editor-1',
        }),
        'editor-1',
      );
    });

    it('puts the picked member on the piece and links their credit to their account', async () => {
      // PRD-440: the desk's translator picker sends the member and their
      // name together, so the job lands on them and the credit line links
      // to their profile.
      const original = makeOriginalPiece();
      const article = makeOriginalArticle();
      const { getSavedPiece } = wireOriginal(original, article);

      const dto: CreateArticleTranslationDto = {
        locale: 'pt',
        translatorUserId: 'translator-1',
        translatorByline: 'Rita Lopes',
      };
      await service.createTranslation('piece-1', dto, 'editor-1');

      expect(getSavedPiece().writerId).toBe('translator-1');
      expect(authors.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          name: 'Rita Lopes',
          userId: 'translator-1',
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'translator-1',
        NotificationType.MagazinePieceCommissioned,
        expect.anything(),
        'editor-1',
      );
    });

    it('rings no bell when the translation opens with no translator assigned', async () => {
      const original = makeOriginalPiece();
      const article = makeOriginalArticle();
      wireOriginal(original, article);

      const dto: CreateArticleTranslationDto = { locale: 'pt' };
      await service.createTranslation('piece-1', dto, 'editor-1');

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('rings no bell when the editor assigns the translation to themselves', async () => {
      const original = makeOriginalPiece();
      const article = makeOriginalArticle();
      wireOriginal(original, article);

      const dto: CreateArticleTranslationDto = {
        locale: 'pt',
        translatorUserId: 'editor-1',
      };
      await service.createTranslation('piece-1', dto, 'editor-1');

      expect(notifications.create).not.toHaveBeenCalled();
    });
  });
});
