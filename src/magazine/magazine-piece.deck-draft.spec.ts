import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { CreatePieceDto } from './dto/create-piece.dto';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineArticleComment } from './entities/magazine-article-comment.entity';
import { MagazineArticleVersion } from './entities/magazine-article-version.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazineCorrection } from './entities/magazine-correction.entity';
import { MagazineDeck } from './entities/magazine-deck.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import { MagazineLetter } from './entities/magazine-letter.entity';
import { MagazinePayment } from './entities/magazine-payment.entity';
import { MagazinePieceEvent } from './entities/magazine-piece-event.entity';
import { MagazinePieceMessage } from './entities/magazine-piece-message.entity';
import { MagazinePiece } from './entities/magazine-piece.entity';
import { MagazinePitch } from './entities/magazine-pitch.entity';
import { MagazineSection } from './entities/magazine-section.entity';
import {
  DECK_CONVERT_PUBLISHED_CODE,
  MagazinePieceService,
} from './magazine-piece.service';
import { MagazineIssueAnnouncerService } from './magazine-issue-announcer.service';

type RepositoryMock = {
  find: jest.Mock;
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  delete: jest.Mock;
  /** The commission's conditional pitch claim. Defaults to "claimed". */
  update: jest.Mock;
};

function makeRepositoryMock(): RepositoryMock {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((entity: unknown) => entity),
    save: jest.fn((entity: unknown) => Promise.resolve(entity)),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

const INJECTED_ENTITIES = [
  MagazinePieceMessage,
  MagazineSection,
  MagazinePayment,
  MagazineLetter,
  MagazineCorrection,
  MagazineArticleComment,
  MagazineArticleVersion,
  MagazineAuthor,
  MagazineIssue,
  UserStaffRole,
  User,
  Profile,
];

/**
 * The desk's "Build a deck" action creates a deck-format piece and opens the
 * deck editor on the piece's `deckId`, so creating a deck piece has to create
 * its deck in the same call. Commissioning a deck pitch and switching an
 * empty piece to `deck` follow the same rule, and converting a deck to an
 * article leaves no deck behind.
 */
describe('MagazinePieceService deck drafts', () => {
  let service: MagazinePieceService;
  let pieces: RepositoryMock;
  let decks: RepositoryMock;
  let pitches: RepositoryMock;
  let pieceEvents: RepositoryMock;
  let articles: RepositoryMock;
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    pieces = makeRepositoryMock();
    decks = makeRepositoryMock();
    pitches = makeRepositoryMock();
    pieceEvents = makeRepositoryMock();
    articles = makeRepositoryMock();
    pieces.save.mockImplementation((entity: MagazinePiece) => {
      entity.id = 'piece-1';
      return Promise.resolve(entity);
    });
    decks.save.mockImplementation((entity: MagazineDeck) => {
      entity.id = 'deck-1';
      return Promise.resolve(entity);
    });
    // Every write inside a transaction goes through its manager, which hands
    // back the same repository mocks the service was injected with.
    const transactionRepositories = new Map<unknown, RepositoryMock>([
      [MagazineDeck, decks],
      [MagazinePiece, pieces],
      [MagazinePitch, pitches],
      [MagazinePieceEvent, pieceEvents],
      [MagazineArticle, articles],
    ]);
    const manager = {
      getRepository: (entity: unknown) =>
        transactionRepositories.get(entity) ?? makeRepositoryMock(),
    };
    dataSource = {
      transaction: jest.fn(
        (work: (transactionManager: typeof manager) => Promise<unknown>) =>
          work(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MagazinePieceService,
        { provide: getRepositoryToken(MagazinePiece), useValue: pieces },
        { provide: getRepositoryToken(MagazineDeck), useValue: decks },
        { provide: getRepositoryToken(MagazinePitch), useValue: pitches },
        {
          provide: getRepositoryToken(MagazinePieceEvent),
          useValue: pieceEvents,
        },
        { provide: getRepositoryToken(MagazineArticle), useValue: articles },
        ...INJECTED_ENTITIES.map((entity) => ({
          provide: getRepositoryToken(entity),
          useValue: makeRepositoryMock(),
        })),
        { provide: DataSource, useValue: dataSource },
        {
          provide: NotificationsService,
          useValue: { create: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: MagazineIssueAnnouncerService,
          useValue: { announceIssueIfDue: jest.fn().mockResolvedValue(false) },
        },
      ],
    }).compile();

    service = module.get(MagazinePieceService);
  });

  const DECK_PIECE: CreatePieceDto = {
    format: 'deck',
    title: 'Ten years of Lisbon Pride',
    section: 'Photo',
    editorId: 'editor-1',
    writerId: 'editor-1',
    byline: 'Rui Matos',
  };

  it('creates an empty unpublished deck and links it before saving the piece', async () => {
    const result = await service.createPiece(DECK_PIECE, 'editor-1');

    expect(decks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'ten-years-of-lisbon-pride',
        title: 'Ten years of Lisbon Pride',
        section: 'Photo',
        byline: 'Rui Matos',
        slides: [],
        publishedAt: null,
      }),
    );
    const [[savedPiece]] = pieces.save.mock.calls as [[MagazinePiece]];
    expect(savedPiece.deckId).toBe('deck-1');
    expect(result.deckId).toBe('deck-1');
    // The deck is saved first, so a saved deck piece always has its deck.
    const [deckSaveOrder] = decks.save.mock.invocationCallOrder;
    const [pieceSaveOrder] = pieces.save.mock.invocationCallOrder;
    expect(deckSaveOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(
      pieceSaveOrder ?? 0,
    );
  });

  it('takes a free slug when the title slug is already used', async () => {
    decks.findOne.mockImplementation(({ where }: { where: { slug: string } }) =>
      Promise.resolve(
        where.slug === 'ten-years-of-lisbon-pride' ? { id: 'other' } : null,
      ),
    );

    await service.createPiece(DECK_PIECE, 'editor-1');

    const [[createdDeck]] = decks.create.mock.calls as [[MagazineDeck]];
    expect(createdDeck.slug).toMatch(/^ten-years-of-lisbon-pride-[0-9a-f]{6}$/);
  });

  it('saves the deck and the piece in one transaction', async () => {
    await service.createPiece(DECK_PIECE, 'editor-1');

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(decks.save).toHaveBeenCalledTimes(1);
    expect(pieces.save).toHaveBeenCalledTimes(1);
  });

  it('passes a failed piece save up so the transaction rolls the deck back', async () => {
    pieces.save.mockRejectedValueOnce(new Error('piece insert failed'));

    await expect(service.createPiece(DECK_PIECE, 'editor-1')).rejects.toThrow(
      'piece insert failed',
    );
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('runs once more with a fresh slug when a concurrent build took the slug', async () => {
    decks.save.mockRejectedValueOnce({
      code: '23505',
      constraint: 'UQ_magazine_deck_slug',
    });
    // The second run sees the winner's deck and takes a suffixed slug.
    decks.findOne
      .mockResolvedValueOnce(null)
      .mockImplementation(({ where }: { where: { slug: string } }) =>
        Promise.resolve(
          where.slug === 'ten-years-of-lisbon-pride' ? { id: 'winner' } : null,
        ),
      );

    const result = await service.createPiece(DECK_PIECE, 'editor-1');

    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    const createdDeckCalls = decks.create.mock.calls as [MagazineDeck][];
    expect(createdDeckCalls[1]?.[0].slug).toMatch(
      /^ten-years-of-lisbon-pride-[0-9a-f]{6}$/,
    );
    expect(result.deckId).toBe('deck-1');
  });

  it('does not retry a unique violation on another constraint', async () => {
    decks.save.mockRejectedValueOnce({
      code: '23505',
      constraint: 'UQ_some_other_index',
    });

    await expect(
      service.createPiece(DECK_PIECE, 'editor-1'),
    ).rejects.toMatchObject({ constraint: 'UQ_some_other_index' });
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('creates no deck for an article piece', async () => {
    const result = await service.createPiece(
      { ...DECK_PIECE, format: 'article' },
      'editor-1',
    );

    expect(decks.create).not.toHaveBeenCalled();
    expect(result.deckId ?? null).toBeNull();
  });

  describe('commissioning a pitch', () => {
    function makePitch(overrides: Partial<MagazinePitch> = {}): MagazinePitch {
      return {
        id: 'pitch-1',
        title: 'Ten years of Lisbon Pride',
        from: 'Rui Matos',
        note: '',
        tags: [],
        suggestFormat: 'deck',
        status: 'waiting',
        fresh: false,
        issueId: null,
        passTemplate: null,
        passNote: null,
        submitterId: null,
        storySubmissionId: null,
        returnedAt: null,
        createdAt: new Date('2026-09-01T09:00:00Z'),
        ...overrides,
      };
    }

    const COMMISSION = {
      verdict: 'commission' as const,
      editorId: 'editor-1',
      section: 'Photo',
    };

    beforeEach(() => {
      // The pitch is read once before the transaction and again inside it;
      // each read gets a fresh row, as it would from the database.
      pitches.findOne.mockImplementation(() => Promise.resolve(makePitch()));
    });

    it('creates the draft deck inside the commission transaction for a deck pitch', async () => {
      const result = await service.triagePitch(
        'pitch-1',
        COMMISSION,
        'editor-1',
      );

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(decks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'ten-years-of-lisbon-pride',
          title: 'Ten years of Lisbon Pride',
          section: 'Photo',
          slides: [],
          publishedAt: null,
        }),
      );
      const [[savedPiece]] = pieces.save.mock.calls as [[MagazinePiece]];
      expect(savedPiece.format).toBe('deck');
      expect(savedPiece.deckId).toBe('deck-1');
      expect((result as { deckId?: string | null }).deckId).toBe('deck-1');
      const [deckSaveOrder] = decks.save.mock.invocationCallOrder;
      const [pieceSaveOrder] = pieces.save.mock.invocationCallOrder;
      expect(deckSaveOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(
        pieceSaveOrder ?? 0,
      );
    });

    it('uses the format the editor picked over the pitch suggestion', async () => {
      await service.triagePitch(
        'pitch-1',
        { ...COMMISSION, format: 'article' },
        'editor-1',
      );

      expect(decks.create).not.toHaveBeenCalled();
      const [[savedPiece]] = pieces.save.mock.calls as [[MagazinePiece]];
      expect(savedPiece.deckId ?? null).toBeNull();
    });

    it('runs the whole commission once more when a concurrent build took the slug', async () => {
      decks.save.mockRejectedValueOnce({
        code: '23505',
        constraint: 'UQ_magazine_deck_slug',
      });

      await service.triagePitch('pitch-1', COMMISSION, 'editor-1');

      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(pieces.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('changing a piece format', () => {
    function makePiece(overrides: Partial<MagazinePiece> = {}): MagazinePiece {
      return {
        id: 'piece-1',
        format: 'article',
        title: 'Ten years of Lisbon Pride',
        section: 'Photo',
        kind: null,
        stage: 'commissioned',
        editorId: 'editor-1',
        writerId: null,
        byline: 'Rui Matos',
        dueOn: null,
        issueId: null,
        articleId: null,
        deckId: null,
        brief: null,
        care: null,
        createdAt: new Date('2026-09-01T09:00:00Z'),
        updatedAt: new Date('2026-09-01T09:00:00Z'),
        ...overrides,
      } as MagazinePiece;
    }

    it('creates the draft deck when an empty piece switches to deck', async () => {
      pieces.findOne.mockResolvedValue(makePiece());

      const result = await service.updatePiece(
        'piece-1',
        { format: 'deck' },
        'editor-1',
      );

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      const [[savedPiece]] = pieces.save.mock.calls as [[MagazinePiece]];
      expect(savedPiece.format).toBe('deck');
      expect(savedPiece.deckId).toBe('deck-1');
      expect(result.deckId).toBe('deck-1');
    });

    it('refuses a format change on a piece that already has content', async () => {
      pieces.findOne.mockResolvedValue(makePiece({ articleId: 'article-1' }));

      await expect(
        service.updatePiece('piece-1', { format: 'deck' }, 'editor-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(decks.create).not.toHaveBeenCalled();
      expect(pieces.save).not.toHaveBeenCalled();
    });

    it('gives a deck piece already holding an article no second content row', async () => {
      pieces.findOne.mockResolvedValue(
        makePiece({ format: 'deck', articleId: 'article-1' }),
      );

      await service.updatePiece('piece-1', { format: 'deck' }, 'editor-1');

      expect(decks.create).not.toHaveBeenCalled();
      const [[savedPiece]] = pieces.save.mock.calls as [[MagazinePiece]];
      expect(savedPiece.deckId).toBeNull();
    });

    it('leaves an article piece alone when the format is not sent', async () => {
      pieces.findOne.mockResolvedValue(makePiece());

      await service.updatePiece('piece-1', { title: 'Renamed' }, 'editor-1');

      expect(decks.create).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('converting a deck to an article', () => {
    function makeDeck(overrides: Partial<MagazineDeck> = {}): MagazineDeck {
      return {
        id: 'deck-1',
        slug: 'ten-years-of-lisbon-pride',
        title: 'Ten years of Lisbon Pride',
        kicker: '',
        section: 'Photo',
        byline: 'Rui Matos',
        role: null,
        authorBio: '',
        cover: '',
        coverDesc: '',
        readTime: '',
        tags: [],
        related: [],
        slides: [{ layout: 'text', body: 'A slide.' }],
        publishedAt: null,
        createdAt: new Date('2026-09-01T09:00:00Z'),
        updatedAt: new Date('2026-09-01T09:00:00Z'),
        ...overrides,
      };
    }

    const LINKED_PIECE = {
      id: 'piece-1',
      format: 'deck',
      title: 'Ten years of Lisbon Pride',
      section: 'Photo',
      byline: 'Rui Matos',
      writerId: null,
      issueId: null,
      articleId: null,
      deckId: 'deck-1',
    } as MagazinePiece;

    it('deletes the draft deck in the same transaction that relinks the piece', async () => {
      decks.findOne.mockResolvedValue(makeDeck());
      pieces.findOne.mockResolvedValue({ ...LINKED_PIECE });
      articles.save.mockImplementation((entity: { id?: string }) => {
        entity.id = 'article-1';
        return Promise.resolve(entity);
      });

      const result = await service.convertDeckToArticle('deck-1', 'editor-1');

      expect(result.articleId).toBe('article-1');
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(decks.delete).toHaveBeenCalledWith({
        id: 'deck-1',
        publishedAt: IsNull(),
      });
      const [[savedPiece]] = pieces.save.mock.calls as [[MagazinePiece]];
      expect(savedPiece.deckId).toBeNull();
      expect(savedPiece.articleId).toBe('article-1');
      expect(savedPiece.format).toBe('article');
    });

    it('refuses to convert a published deck and writes nothing', async () => {
      decks.findOne.mockResolvedValue(
        makeDeck({ publishedAt: new Date('2026-09-02T09:00:00Z') }),
      );
      pieces.findOne.mockResolvedValue({ ...LINKED_PIECE });

      const error: unknown = await service
        .convertDeckToArticle('deck-1', 'editor-1')
        .then(
          () => null,
          (rejection: unknown) => rejection,
        );
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual(
        expect.objectContaining({ code: DECK_CONVERT_PUBLISHED_CODE }),
      );
      expect(articles.save).not.toHaveBeenCalled();
      expect(pieces.save).not.toHaveBeenCalled();
      expect(decks.delete).not.toHaveBeenCalled();
    });

    it('rolls the conversion back when the deck went live after the check', async () => {
      decks.findOne.mockResolvedValue(makeDeck());
      pieces.findOne.mockResolvedValue({ ...LINKED_PIECE });
      // The conditional delete matched nothing: a publish landed in between.
      decks.delete.mockResolvedValueOnce({ affected: 0 });

      await expect(
        service.convertDeckToArticle('deck-1', 'editor-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });
  });
});
