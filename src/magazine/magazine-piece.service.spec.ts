import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { CreateCorrectionDto } from './dto/create-correction.dto';
import { CreateLetterDto } from './dto/create-letter.dto';
import { CreatePieceDto } from './dto/create-piece.dto';
import { SubmitPitchDto } from './dto/submit-pitch.dto';
import { TriagePitchDto } from './dto/triage-pitch.dto';
import { UpdateArticleDto } from './dto/update-article.dto';
import { UpdateBylineDto } from './dto/update-byline.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { UpdatePieceDto } from './dto/update-piece.dto';
import { UpdateRunOrderDto } from './dto/update-run-order.dto';
import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineArticleComment } from './entities/magazine-article-comment.entity';
import { MagazineArticleVersion } from './entities/magazine-article-version.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazineCorrection } from './entities/magazine-correction.entity';
import { MagazineDeck } from './entities/magazine-deck.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import { MagazineLetter } from './entities/magazine-letter.entity';
import { MagazineNotificationRead } from './entities/magazine-notification-read.entity';
import { MagazinePayment } from './entities/magazine-payment.entity';
import { MagazinePieceEvent } from './entities/magazine-piece-event.entity';
import { MagazinePieceMessage } from './entities/magazine-piece-message.entity';
import { MagazinePiece, PieceCare } from './entities/magazine-piece.entity';
import { MagazinePitch } from './entities/magazine-pitch.entity';
import { MagazineSection } from './entities/magazine-section.entity';
import { MagazinePieceService } from './magazine-piece.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';

type RepositoryMock = {
  find: jest.Mock;
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  remove: jest.Mock;
  count: jest.Mock;
  createQueryBuilder: jest.Mock;
};

function makeRepositoryMock(): RepositoryMock {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((entity: unknown) => entity),
    save: jest.fn((entity: unknown) => Promise.resolve(entity)),
    remove: jest.fn((entity: unknown) => Promise.resolve(entity)),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(),
  };
}

const PIECE: MagazinePiece = {
  id: 'piece-1',
  format: 'article',
  title: 'On chosen family',
  section: 'Features',
  kind: null,
  stage: 'drafting',
  editorId: 'editor-1',
  writerId: 'writer-1',
  byline: 'Kai Duarte',
  dueOn: null,
  issueId: null,
  articleId: null,
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
  care: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
};

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    role: UserRole.Member,
    ...overrides,
  } as unknown as User;
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    userId: 'user-1',
    slug: 'user-1',
    firstName: 'Ana',
    lastName: 'Silva',
    avatarUrl: null,
    ...overrides,
  } as unknown as Profile;
}

const ARTICLE: MagazineArticle = {
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
  contentNotes: [],
  blocks: [],
  authorId: 'author-1',
  issueId: null,
  tags: [],
  readMinutes: 1,
  publishedAt: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
};

const ISSUE: MagazineIssue = {
  id: 'issue-1',
  number: '05',
  title: 'The Belonging Issue',
  dek: '',
  publishedOn: '',
  coverUrl: null,
  theme: 'Belonging',
  runOrder: [],
  digest: [],
  coverlines: [],
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
};

/** A `PieceCare` record with every publish-gate item settled. */
const PAST_GATE_CARE: PieceCare = {
  subjects: [],
  contentNotes: ['All good.'],
  flags: [],
  read: {
    reader: 'Alex',
    role: 'sensitivity reader',
    status: 'done',
    askedOn: '2026-07-01',
    dueOn: '2026-07-10',
    checks: [],
  },
};

const PITCH: MagazinePitch = {
  id: 'pitch-1',
  title: 'A piece about queer nightlife',
  from: 'Sofia Andrade',
  note: 'Would love to write about this.',
  tags: ['Nightlife'],
  suggestFormat: 'article',
  status: 'waiting',
  fresh: true,
  issueId: null,
  passTemplate: null,
  passNote: null,
  submitterId: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

describe('MagazinePieceService', () => {
  let service: MagazinePieceService;
  let pieces: RepositoryMock;
  let pitches: RepositoryMock;
  let pieceEvents: RepositoryMock;
  let pieceMessages: RepositoryMock;
  let sections: RepositoryMock;
  let payments: RepositoryMock;
  let letters: RepositoryMock;
  let notificationReads: RepositoryMock;
  let corrections: RepositoryMock;
  let articles: RepositoryMock;
  let articleComments: RepositoryMock;
  let articleVersions: RepositoryMock;
  let authors: RepositoryMock;
  let decks: RepositoryMock;
  let issues: RepositoryMock;
  let staffRoles: RepositoryMock;
  let users: RepositoryMock;
  let profiles: RepositoryMock;
  let transactionManager: { getRepository: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    pieces = makeRepositoryMock();
    pitches = makeRepositoryMock();
    pieceEvents = makeRepositoryMock();
    pieceMessages = makeRepositoryMock();
    sections = makeRepositoryMock();
    payments = makeRepositoryMock();
    letters = makeRepositoryMock();
    notificationReads = makeRepositoryMock();
    corrections = makeRepositoryMock();
    articles = makeRepositoryMock();
    articleComments = makeRepositoryMock();
    articleVersions = makeRepositoryMock();
    authors = makeRepositoryMock();
    decks = makeRepositoryMock();
    issues = makeRepositoryMock();
    staffRoles = makeRepositoryMock();
    users = makeRepositoryMock();
    profiles = makeRepositoryMock();

    // The commission/ship flows run inside `dataSource.transaction`,
    // resolving per-entity repos off the transactional `EntityManager` —
    // route each `manager.getRepository(Entity)` call back to the same
    // mocks so assertions can inspect them regardless of which path wrote
    // to them.
    transactionManager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === MagazinePiece) return pieces;
        if (entity === MagazinePitch) return pitches;
        if (entity === MagazinePieceEvent) return pieceEvents;
        if (entity === MagazineArticle) return articles;
        if (entity === MagazineDeck) return decks;
        if (entity === MagazineIssue) return issues;
        return sections;
      }),
    };
    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(
          (
            runInTransaction: (
              manager: typeof transactionManager,
            ) => Promise<unknown>,
          ) => runInTransaction(transactionManager),
        ),
    };
    notifications = { create: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MagazinePieceService,
        { provide: getRepositoryToken(MagazinePiece), useValue: pieces },
        { provide: getRepositoryToken(MagazinePitch), useValue: pitches },
        {
          provide: getRepositoryToken(MagazinePieceEvent),
          useValue: pieceEvents,
        },
        {
          provide: getRepositoryToken(MagazinePieceMessage),
          useValue: pieceMessages,
        },
        { provide: getRepositoryToken(MagazineSection), useValue: sections },
        { provide: getRepositoryToken(MagazinePayment), useValue: payments },
        { provide: getRepositoryToken(MagazineLetter), useValue: letters },
        {
          provide: getRepositoryToken(MagazineNotificationRead),
          useValue: notificationReads,
        },
        {
          provide: getRepositoryToken(MagazineCorrection),
          useValue: corrections,
        },
        { provide: getRepositoryToken(MagazineArticle), useValue: articles },
        {
          provide: getRepositoryToken(MagazineArticleComment),
          useValue: articleComments,
        },
        {
          provide: getRepositoryToken(MagazineArticleVersion),
          useValue: articleVersions,
        },
        { provide: getRepositoryToken(MagazineAuthor), useValue: authors },
        { provide: getRepositoryToken(MagazineDeck), useValue: decks },
        { provide: getRepositoryToken(MagazineIssue), useValue: issues },
        { provide: getRepositoryToken(UserStaffRole), useValue: staffRoles },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get(MagazinePieceService);
  });

  describe('createPiece', () => {
    it('flips a linked pitch to commissioned and records a commissioned event', async () => {
      const pitch = { ...PITCH };
      pitches.findOne.mockResolvedValue(pitch);
      pieces.save.mockImplementation((entity: MagazinePiece) => {
        entity.id = 'piece-1';
        return Promise.resolve(entity);
      });
      pieceEvents.find.mockResolvedValue([
        {
          id: 'event-1',
          pieceId: 'piece-1',
          actorId: 'editor-1',
          action: 'commissioned',
          detail: null,
          createdAt: new Date('2026-08-10T00:00:00.000Z'),
        } as MagazinePieceEvent,
      ]);

      const dto: CreatePieceDto = {
        format: 'article',
        title: 'A feature',
        section: 'Features',
        editorId: 'editor-1',
        pitchId: 'pitch-1',
      };

      const result = await service.createPiece(dto, 'editor-1');

      expect(pitch.status).toBe('commissioned');
      expect(pitches.save).toHaveBeenCalledWith(pitch);
      expect(pieceEvents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          pieceId: 'piece-1',
          actorId: 'editor-1',
          action: 'commissioned',
        }),
      );
      expect(result.id).toBe('piece-1');
      expect(result.audit).toHaveLength(1);
    });
  });

  describe('updatePiece', () => {
    it('records a stage_changed event when the stage moves', async () => {
      const piece = { ...PIECE };
      pieces.findOne.mockResolvedValue(piece);
      pieceEvents.find.mockResolvedValue([]);

      const dto: UpdatePieceDto = { stage: 'in_review' };
      await service.updatePiece('piece-1', dto, 'editor-1');

      expect(piece.stage).toBe('in_review');
      expect(pieceEvents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          pieceId: 'piece-1',
          actorId: 'editor-1',
          action: 'stage_changed',
          detail: 'in_review',
        }),
      );
    });

    it('propagates BadRequestException from validatePieceBrief on a malformed brief', async () => {
      pieces.findOne.mockResolvedValue({ ...PIECE });

      const dto: UpdatePieceDto = { brief: { angle: 'missing fields' } };
      await expect(
        service.updatePiece('piece-1', dto, 'editor-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(pieces.save).not.toHaveBeenCalled();
    });
  });

  describe('getPieceById', () => {
    it('throws NotFoundException when the piece does not exist', async () => {
      pieces.findOne.mockResolvedValue(null);
      await expect(service.getPieceById('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('triagePitch', () => {
    it("sets status 'passed' and stores the pass template/note on a pass verdict", async () => {
      const pitch = { ...PITCH };
      pitches.findOne.mockResolvedValue(pitch);

      const dto: TriagePitchDto = {
        verdict: 'pass',
        passTemplate: 'not-a-fit',
        passNote: 'Doesn’t fit an upcoming issue.',
      };
      const result = await service.triagePitch('pitch-1', dto, 'editor-1');

      expect(pitch.status).toBe('passed');
      expect(pitch.passTemplate).toBe('not-a-fit');
      expect(pitches.save).toHaveBeenCalledWith(pitch);
      expect(result).toMatchObject({ status: 'passed' });
    });

    it('creates a piece from the pitch inside a transaction on a commission verdict', async () => {
      const pitch = { ...PITCH };
      pitches.findOne.mockResolvedValue(pitch);
      pieces.save.mockImplementation((entity: MagazinePiece) => {
        entity.id = 'piece-2';
        return Promise.resolve(entity);
      });
      pieceEvents.find.mockResolvedValue([]);

      const dto: TriagePitchDto = {
        verdict: 'commission',
        editorId: 'editor-1',
        section: 'Features',
      };
      const result = await service.triagePitch('pitch-1', dto, 'editor-1');

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(pitch.status).toBe('commissioned');
      expect(result).toMatchObject({
        id: 'piece-2',
        title: PITCH.title,
        byline: PITCH.from,
      });
    });

    it('rejects re-commissioning a pitch that was already triaged, without creating a second piece', async () => {
      const alreadyCommissioned = { ...PITCH, status: 'commissioned' as const };
      pitches.findOne.mockResolvedValue(alreadyCommissioned);

      const dto: TriagePitchDto = {
        verdict: 'commission',
        editorId: 'editor-1',
        section: 'Features',
      };

      await expect(
        service.triagePitch('pitch-1', dto, 'editor-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(pieces.save).not.toHaveBeenCalled();
      expect(pitches.save).not.toHaveBeenCalled();
    });
  });

  describe('getPieceRecordFull', () => {
    it('throws NotFoundException when the piece does not exist', async () => {
      pieces.findOne.mockResolvedValue(null);
      await expect(
        service.getPieceRecordFull('missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns a null payment when none has been recorded yet', async () => {
      pieces.findOne.mockResolvedValue({ ...PIECE });
      pieceEvents.find.mockResolvedValue([]);
      payments.findOne.mockResolvedValue(null);
      letters.find.mockResolvedValue([]);
      corrections.find.mockResolvedValue([]);

      const result = await service.getPieceRecordFull('piece-1');

      expect(result.payment).toBeNull();
      expect(result.letters).toEqual([]);
      expect(result.corrections).toEqual([]);
    });
  });

  describe('upsertPayment', () => {
    it('throws NotFoundException when the piece does not exist', async () => {
      pieces.findOne.mockResolvedValue(null);
      const dto: UpdatePaymentDto = { fee: '€420' };
      await expect(
        service.upsertPayment('missing', dto, 'editor-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates the payment row when none exists yet', async () => {
      pieces.findOne.mockResolvedValue({ ...PIECE });
      payments.findOne.mockResolvedValue(null);

      const dto: UpdatePaymentDto = { fee: '€420', invoice: 'INV-2026-084' };
      const result = await service.upsertPayment('piece-1', dto, 'editor-1');

      expect(payments.create).toHaveBeenCalledWith(
        expect.objectContaining({ pieceId: 'piece-1', fee: '€420' }),
      );
      expect(payments.save).toHaveBeenCalled();
      expect(pieceEvents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          pieceId: 'piece-1',
          actorId: 'editor-1',
          action: 'payment_updated',
        }),
      );
      expect(result.fee).toBe('€420');
      expect(result.invoice).toBe('INV-2026-084');
    });

    it("stamps paidOn on a first-time create when status is 'paid'", async () => {
      pieces.findOne.mockResolvedValue({ ...PIECE });
      payments.findOne.mockResolvedValue(null);

      const dto: UpdatePaymentDto = { fee: '€1', status: 'paid' };
      const result = await service.upsertPayment('piece-1', dto, 'editor-1');

      expect(result.paidOn).not.toBeNull();
      expect(result.paidOn).not.toBeUndefined();
    });

    it('updates the existing payment row instead of creating a second one', async () => {
      pieces.findOne.mockResolvedValue({ ...PIECE });
      const existingPayment: MagazinePayment = {
        id: 'payment-1',
        pieceId: 'piece-1',
        fee: '€420',
        expenses: null,
        invoice: null,
        filedOn: null,
        terms: '21 days',
        dueOn: null,
        status: 'agreed',
        paidOn: null,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        updatedAt: new Date('2026-08-01T00:00:00.000Z'),
      };
      payments.findOne.mockResolvedValue(existingPayment);

      const dto: UpdatePaymentDto = { status: 'approved_unpaid' };
      const result = await service.upsertPayment('piece-1', dto, 'editor-1');

      expect(payments.create).not.toHaveBeenCalled();
      expect(payments.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'payment-1', status: 'approved_unpaid' }),
      );
      expect(result.status).toBe('approved_unpaid');
    });

    it("stamps paidOn with today's date when status moves to 'paid' without one", async () => {
      pieces.findOne.mockResolvedValue({ ...PIECE });
      const existingPayment: MagazinePayment = {
        id: 'payment-1',
        pieceId: 'piece-1',
        fee: '€420',
        expenses: null,
        invoice: null,
        filedOn: null,
        terms: '21 days',
        dueOn: null,
        status: 'approved_unpaid',
        paidOn: null,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        updatedAt: new Date('2026-08-01T00:00:00.000Z'),
      };
      payments.findOne.mockResolvedValue(existingPayment);

      const dto: UpdatePaymentDto = { status: 'paid' };
      const result = await service.upsertPayment('piece-1', dto, 'editor-1');

      expect(result.status).toBe('paid');
      expect(result.paidOn).not.toBeNull();
    });

    it('does not overwrite an explicit paidOn when status moves to paid', async () => {
      pieces.findOne.mockResolvedValue({ ...PIECE });
      const existingPayment: MagazinePayment = {
        id: 'payment-1',
        pieceId: 'piece-1',
        fee: '€420',
        expenses: null,
        invoice: null,
        filedOn: null,
        terms: '21 days',
        dueOn: null,
        status: 'approved_unpaid',
        paidOn: null,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        updatedAt: new Date('2026-08-01T00:00:00.000Z'),
      };
      payments.findOne.mockResolvedValue(existingPayment);

      const dto: UpdatePaymentDto = { status: 'paid', paidOn: '2026-07-01' };
      const result = await service.upsertPayment('piece-1', dto, 'editor-1');

      expect(result.paidOn).toBe('2026-07-01');
    });
  });

  describe('getArticleDraft', () => {
    it('auto-creates and links an article when the piece has no articleId yet', async () => {
      const piece = { ...PIECE, articleId: null };
      pieces.findOne.mockResolvedValue(piece);
      articles.save.mockImplementation((entity: MagazineArticle) => {
        entity.id = 'article-1';
        return Promise.resolve(entity);
      });

      const result = await service.getArticleDraft('piece-1');

      expect(piece.articleId).toBe('article-1');
      expect(pieces.save).toHaveBeenCalledWith(piece);
      expect(articles.save).toHaveBeenCalled();
      expect(pieceEvents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          pieceId: 'piece-1',
          actorId: null,
          action: 'article_created',
        }),
      );
      expect(result.id).toBe('article-1');
      expect(result.blocks).toEqual([]);
      expect(result.title).toBe(piece.title);
    });

    it('loads the existing article without creating a new one when articleId is already set', async () => {
      const piece = { ...PIECE, articleId: 'article-1' };
      pieces.findOne.mockResolvedValue(piece);
      articles.findOne.mockResolvedValue({ ...ARTICLE });

      const result = await service.getArticleDraft('piece-1');

      expect(articles.save).not.toHaveBeenCalled();
      expect(pieces.save).not.toHaveBeenCalled();
      expect(result.id).toBe('article-1');
    });

    it('throws NotFoundException when the piece does not exist', async () => {
      pieces.findOne.mockResolvedValue(null);
      await expect(service.getArticleDraft('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('updateArticleDraft', () => {
    it('throws BadRequestException on malformed blocks without saving', async () => {
      const piece = { ...PIECE, articleId: 'article-1' };
      pieces.findOne.mockResolvedValue(piece);
      articles.findOne.mockResolvedValue({ ...ARTICLE });

      const dto: UpdateArticleDto = {
        blocks: [{ id: 'b1', kind: 'paragraph' }],
      };

      await expect(
        service.updateArticleDraft('piece-1', dto, 'editor-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(articles.save).not.toHaveBeenCalled();
      expect(pieceEvents.create).not.toHaveBeenCalled();
    });

    it('derives a positive readMinutes from a non-empty block set and records article_edited', async () => {
      const piece = { ...PIECE, articleId: 'article-1' };
      pieces.findOne.mockResolvedValue(piece);
      articles.findOne.mockResolvedValue({ ...ARTICLE, blocks: [] });

      const dto: UpdateArticleDto = {
        blocks: [
          { id: 'b1', kind: 'paragraph', html: 'word '.repeat(300).trim() },
        ],
      };

      const result = await service.updateArticleDraft(
        'piece-1',
        dto,
        'editor-1',
      );

      expect(articles.save).toHaveBeenCalled();
      expect(pieceEvents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          pieceId: 'piece-1',
          actorId: 'editor-1',
          action: 'article_edited',
        }),
      );
      expect(result.blocks).toHaveLength(1);
      expect(result.readMinutes).toBeGreaterThan(0);
    });

    it('merges a rapid second article_edited event into the existing row instead of creating a new one', async () => {
      const piece = { ...PIECE, articleId: 'article-1' };
      pieces.findOne.mockResolvedValue(piece);
      articles.findOne.mockResolvedValue({ ...ARTICLE, blocks: [] });

      const recentEvent = {
        id: 'event-1',
        pieceId: 'piece-1',
        actorId: 'editor-1',
        action: 'article_edited',
        detail: null,
        createdAt: new Date(Date.now() - 1000),
      };
      pieceEvents.findOne.mockResolvedValue(recentEvent);

      const dto: UpdateArticleDto = {
        blocks: [
          { id: 'b1', kind: 'paragraph', html: 'word '.repeat(300).trim() },
        ],
      };

      await service.updateArticleDraft('piece-1', dto, 'editor-1');

      expect(pieceEvents.create).not.toHaveBeenCalled();
      expect(pieceEvents.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'event-1', action: 'article_edited' }),
      );
    });

    it('merges article_edited into the existing row no matter how long ago it was made, as long as it is still the latest event on the piece', async () => {
      const piece = { ...PIECE, articleId: 'article-1' };
      pieces.findOne.mockResolvedValue(piece);
      articles.findOne.mockResolvedValue({ ...ARTICLE, blocks: [] });

      const staleEvent = {
        id: 'event-1',
        pieceId: 'piece-1',
        actorId: 'editor-1',
        action: 'article_edited',
        detail: null,
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
      };
      pieceEvents.findOne.mockResolvedValue(staleEvent);

      const dto: UpdateArticleDto = { standfirst: 'Updated lede.' };
      await service.updateArticleDraft('piece-1', dto, 'editor-1');

      expect(pieceEvents.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ pieceId: 'piece-1' }),
        }),
      );
      expect(pieceEvents.create).not.toHaveBeenCalled();
      expect(pieceEvents.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'event-1', action: 'article_edited' }),
      );
    });

    it("starts a new article_edited row when the piece's latest event since the last edit is something else", async () => {
      const piece = { ...PIECE, articleId: 'article-1' };
      pieces.findOne.mockResolvedValue(piece);
      articles.findOne.mockResolvedValue({ ...ARTICLE, blocks: [] });

      pieceEvents.findOne.mockResolvedValue({
        id: 'event-1',
        pieceId: 'piece-1',
        actorId: 'editor-2',
        action: 'stage_changed',
        detail: 'ready_to_publish',
        createdAt: new Date(Date.now() - 1000),
      });

      const dto: UpdateArticleDto = { standfirst: 'Updated lede.' };
      await service.updateArticleDraft('piece-1', dto, 'editor-1');

      expect(pieceEvents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          pieceId: 'piece-1',
          actorId: 'editor-1',
          action: 'article_edited',
        }),
      );
    });

    it('auto-creates the article first when the piece has no articleId yet', async () => {
      const piece = { ...PIECE, articleId: null };
      pieces.findOne.mockResolvedValue(piece);
      articles.save.mockImplementation((entity: MagazineArticle) => {
        entity.id = 'article-1';
        return Promise.resolve(entity);
      });

      const dto: UpdateArticleDto = { standfirst: 'A new lede.' };
      const result = await service.updateArticleDraft(
        'piece-1',
        dto,
        'editor-1',
      );

      expect(piece.articleId).toBe('article-1');
      expect(pieceEvents.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'article_created' }),
      );
      expect(pieceEvents.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'article_edited' }),
      );
      expect(result.standfirst).toBe('A new lede.');
    });
  });

  describe('addLetter / listLetters', () => {
    it('throws NotFoundException when the piece does not exist', async () => {
      pieces.findOne.mockResolvedValue(null);
      const dto: CreateLetterDto = { who: 'Cláudia, 58', body: 'Thank you.' };
      await expect(service.addLetter('missing', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('creates and returns a letter', async () => {
      pieces.findOne.mockResolvedValue({ ...PIECE });
      const dto: CreateLetterDto = { who: 'Cláudia, 58', body: 'Thank you.' };
      // A real `CreateDateColumn` only fills `createdAt` on insert, so this
      // test's own `create` mock synthesizes it the same way `pieces.save`
      // fills `id` elsewhere in this file (see `submitPitch`).
      letters.create.mockImplementation((entity: object) => ({
        ...entity,
        id: 'letter-new',
        createdAt: new Date('2026-08-10T00:00:00.000Z'),
      }));

      const result = await service.addLetter('piece-1', dto);

      expect(letters.create).toHaveBeenCalledWith(
        expect.objectContaining({
          pieceId: 'piece-1',
          who: 'Cláudia, 58',
          body: 'Thank you.',
          runInLetters: false,
        }),
      );
      expect(result.who).toBe('Cláudia, 58');
    });

    it('lists letters newest first', async () => {
      letters.find.mockResolvedValue([]);
      const result = await service.listLetters('piece-1');
      expect(letters.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { pieceId: 'piece-1' },
          order: { createdAt: 'DESC' },
        }),
      );
      expect(result).toEqual([]);
    });
  });

  describe('updateLetter', () => {
    const LETTER = {
      id: 'letter-1',
      pieceId: 'piece-1',
      who: 'Cláudia, 58',
      body: 'Thank you.',
      runInLetters: false,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    };

    it('throws NotFoundException when the letter does not exist', async () => {
      letters.findOne.mockResolvedValue(null);
      await expect(
        service.updateLetter('piece-1', 'missing', true),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when the letter belongs to a different piece', async () => {
      letters.findOne.mockResolvedValue({
        ...LETTER,
        pieceId: 'some-other-piece',
      });
      await expect(
        service.updateLetter('piece-1', 'letter-1', true),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('toggles runInLetters on the existing row without creating a new one', async () => {
      letters.findOne.mockResolvedValue({ ...LETTER });

      const result = await service.updateLetter('piece-1', 'letter-1', true);

      expect(letters.create).not.toHaveBeenCalled();
      expect(letters.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'letter-1', runInLetters: true }),
      );
      expect(result.runInLetters).toBe(true);
      expect(result.id).toBe('letter-1');
    });

    it('is idempotent — toggling to the same value re-saves the same row', async () => {
      letters.findOne.mockResolvedValue({ ...LETTER, runInLetters: true });

      const result = await service.updateLetter('piece-1', 'letter-1', true);

      expect(result.runInLetters).toBe(true);
    });
  });

  describe('addCorrection', () => {
    it('throws NotFoundException when the piece does not exist', async () => {
      pieces.findOne.mockResolvedValue(null);
      const dto: CreateCorrectionDto = { text: 'We misstated a date.' };
      await expect(
        service.addCorrection('missing', dto, 'editor-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates a correction and records a correction_published audit event', async () => {
      pieces.findOne.mockResolvedValue({ ...PIECE });
      const dto: CreateCorrectionDto = { text: 'We misstated a date.' };
      // As with letters, the `CreateDateColumn` is DB-populated on insert —
      // synthesize it in the `create` mock so `toCorrectionResponse` has a
      // `createdAt` to serialize.
      corrections.create.mockImplementation((entity: object) => ({
        ...entity,
        id: 'correction-new',
        createdAt: new Date('2026-08-10T00:00:00.000Z'),
      }));

      const result = await service.addCorrection('piece-1', dto, 'editor-1');

      expect(corrections.create).toHaveBeenCalledWith(
        expect.objectContaining({
          pieceId: 'piece-1',
          text: 'We misstated a date.',
        }),
      );
      expect(pieceEvents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          pieceId: 'piece-1',
          actorId: 'editor-1',
          action: 'correction_published',
        }),
      );
      expect(result.text).toBe('We misstated a date.');
      expect(result.publishedOn).not.toBeNull();
    });
  });

  describe('getIssueProduction', () => {
    it('resolves the run order against pieces and derives the ship checklist', async () => {
      issues.findOne.mockResolvedValue({
        ...ISSUE,
        runOrder: [{ pieceId: 'piece-1', pages: '12-14' }],
        coverUrl: 'https://example.com/cover.jpg',
        coverlines: ['A coverline'],
        digest: [{ pieceId: 'piece-1', blurb: 'A blurb', on: true }],
      });
      pieces.find.mockResolvedValue([
        {
          ...PIECE,
          id: 'piece-1',
          issueId: 'issue-1',
          laidOut: true,
          care: PAST_GATE_CARE,
        },
      ]);

      const result = await service.getIssueProduction('05');

      expect(result.runOrder).toHaveLength(1);
      const [runOrderEntry] = result.runOrder;
      expect(runOrderEntry).toMatchObject({
        pages: '12-14',
        laidOut: true,
      });
      expect(runOrderEntry?.piece.id).toBe('piece-1');
      expect(result.shipChecklist).toEqual([
        { label: 'Every piece past the publish gate', done: true },
        { label: 'Cover art set', done: true },
        { label: 'Coverlines written', done: true },
        { label: 'Digest has at least one piece', done: true },
      ]);
    });

    it('throws NotFoundException when the issue does not exist', async () => {
      issues.findOne.mockResolvedValue(null);
      await expect(service.getIssueProduction('99')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('updateRunOrder', () => {
    it('persists the run order on the issue and syncs each referenced piece orderIndex/pages', async () => {
      const issue = { ...ISSUE };
      issues.findOne.mockResolvedValue(issue);

      const pieceA = { ...PIECE, id: 'piece-a', orderIndex: null, pages: null };
      const pieceB = { ...PIECE, id: 'piece-b', orderIndex: null, pages: null };
      // First `pieces.find` call resolves the `In(pieceIds)` lookup used to
      // sync orderIndex/pages; the second is `getIssueProduction`'s own
      // by-issue lookup for the returned response.
      pieces.find.mockResolvedValueOnce([pieceA, pieceB]);
      pieces.find.mockResolvedValueOnce([pieceA, pieceB]);

      const dto: UpdateRunOrderDto = {
        items: [
          { pieceId: 'piece-b', pages: '5-6' },
          { pieceId: 'piece-a', pages: '1-4' },
        ],
      };

      await service.updateRunOrder('05', dto, 'editor-1');

      expect(issue.runOrder).toEqual([
        { pieceId: 'piece-b', pages: '5-6' },
        { pieceId: 'piece-a', pages: '1-4' },
      ]);
      expect(issues.save).toHaveBeenCalledWith(issue);
      expect(pieceB.orderIndex).toBe(0);
      expect(pieceB.pages).toBe('5-6');
      expect(pieceA.orderIndex).toBe(1);
      expect(pieceA.pages).toBe('1-4');
      expect(pieces.save).toHaveBeenCalledWith([pieceB, pieceA]);
      expect(pieceEvents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          pieceId: 'piece-b',
          actorId: 'editor-1',
          action: 'run_order_updated',
        }),
      );
    });
  });

  describe('shipIssue', () => {
    it('publishes only pieces past their publish gate, leaving the rest unpublished', async () => {
      issues.findOne.mockResolvedValue({ ...ISSUE, publishedOn: '2026-08-01' });

      const readyPiece = {
        ...PIECE,
        id: 'piece-ready',
        articleId: 'article-ready',
        care: PAST_GATE_CARE,
      };
      const blockedPiece = {
        ...PIECE,
        id: 'piece-blocked',
        articleId: 'article-blocked',
        care: null,
      };
      pieces.find.mockResolvedValue([readyPiece, blockedPiece]);

      const readyArticle = {
        ...ARTICLE,
        id: 'article-ready',
        publishedAt: null,
      };
      const blockedArticle = {
        ...ARTICLE,
        id: 'article-blocked',
        publishedAt: null,
      };
      articles.findOne.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve(
            where.id === 'article-ready' ? readyArticle : blockedArticle,
          ),
      );

      await service.shipIssue('05', 'editor-1');

      expect(readyArticle.publishedAt).not.toBeNull();
      expect(blockedArticle.publishedAt).toBeNull();
      expect(articles.save).toHaveBeenCalledTimes(1);
      expect(articles.save).toHaveBeenCalledWith(readyArticle);
      expect(pieceEvents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          pieceId: 'piece-ready',
          action: 'issue_shipped',
        }),
      );
      expect(pieceEvents.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ pieceId: 'piece-blocked' }),
      );
    });
  });

  describe('writer workspace (Magazine Desk Phase 6)', () => {
    describe('listMyAssignments', () => {
      it("returns only the writer's own pieces, excluding a piece assigned to someone else", async () => {
        const myPiece = { ...PIECE, id: 'piece-mine', writerId: 'writer-1' };
        const otherPiece = {
          ...PIECE,
          id: 'piece-other',
          writerId: 'writer-2',
        };
        // The repository query is mocked, not real SQL — this fixture models
        // what TypeORM would already have filtered via `where: { writerId }`,
        // so a leak here means the query filter itself is wrong.
        pieces.find.mockImplementation(
          ({ where }: { where: { writerId: string } }) =>
            Promise.resolve(
              [myPiece, otherPiece].filter(
                (piece) => piece.writerId === where.writerId,
              ),
            ),
        );
        payments.findOne.mockResolvedValue(null);

        const result = await service.listMyAssignments('writer-1');

        expect(pieces.find).toHaveBeenCalledWith(
          expect.objectContaining({ where: { writerId: 'writer-1' } }),
        );
        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe('piece-mine');
        expect(
          result.some((assignment) => assignment.id === 'piece-other'),
        ).toBe(false);
      });
    });

    describe('listMyPitches', () => {
      it("scopes to the writer's submitterId", async () => {
        pitches.find.mockResolvedValue([{ ...PITCH, submitterId: 'writer-1' }]);

        await service.listMyPitches('writer-1');

        expect(pitches.find).toHaveBeenCalledWith(
          expect.objectContaining({ where: { submitterId: 'writer-1' } }),
        );
      });
    });

    describe('submitPitch', () => {
      it('stamps submitterId from the authenticated writer, not the request body', async () => {
        // `create()` is normally an in-memory stub (`entity => entity`); a
        // real `CreateDateColumn` only populates `createdAt` on insert, so
        // this test's own mock fills it in the same way `pieces.save` fills
        // `id` elsewhere in this file.
        pitches.create.mockImplementation((entity: Partial<MagazinePitch>) => ({
          ...entity,
          id: 'pitch-new',
          createdAt: new Date('2026-08-10T00:00:00.000Z'),
        }));

        const dto: SubmitPitchDto = {
          title: 'A piece about drag history',
          note: 'Would love to write this up.',
          tags: ['history'],
        };

        const result = await service.submitPitch('writer-1', dto);

        expect(pitches.create).toHaveBeenCalledWith(
          expect.objectContaining({
            submitterId: 'writer-1',
            title: dto.title,
            note: dto.note,
            status: 'waiting',
          }),
        );
        expect(pitches.save).toHaveBeenCalled();
        expect(result.title).toBe(dto.title);
      });
    });

    describe('listMyPayments', () => {
      it("scopes to the writer's own pieces", async () => {
        pieces.find.mockResolvedValue([{ ...PIECE, writerId: 'writer-1' }]);
        payments.findOne.mockResolvedValue(null);

        await service.listMyPayments('writer-1');

        expect(pieces.find).toHaveBeenCalledWith(
          expect.objectContaining({ where: { writerId: 'writer-1' } }),
        );
      });
    });

    describe('updateMyByline', () => {
      it('throws ForbiddenException when the piece is not assigned to the writer', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, writerId: 'writer-2' });

        const dto: UpdateBylineDto = { byline: 'A. Writer' };
        await expect(
          service.updateMyByline('writer-1', 'piece-1', dto),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(pieces.save).not.toHaveBeenCalled();
      });

      it('throws ForbiddenException once the piece is ready, even when owned', async () => {
        pieces.findOne.mockResolvedValue({
          ...PIECE,
          writerId: 'writer-1',
          stage: 'ready' as const,
        });

        const dto: UpdateBylineDto = { byline: 'A. Writer' };
        await expect(
          service.updateMyByline('writer-1', 'piece-1', dto),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(pieces.save).not.toHaveBeenCalled();
      });

      it('sets the byline when owned and not yet ready', async () => {
        const piece = {
          ...PIECE,
          writerId: 'writer-1',
          stage: 'drafting' as const,
        };
        pieces.findOne.mockResolvedValue(piece);
        payments.findOne.mockResolvedValue(null);

        const dto: UpdateBylineDto = { byline: 'A. Writer' };
        const result = await service.updateMyByline('writer-1', 'piece-1', dto);

        expect(piece.byline).toBe('A. Writer');
        expect(pieces.save).toHaveBeenCalledWith(piece);
        expect(result.byline).toBe('A. Writer');
      });
    });

    describe('fileDraft', () => {
      it('throws ForbiddenException when the piece is not assigned to the writer', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, writerId: 'writer-2' });

        await expect(
          service.fileDraft('writer-1', 'piece-1'),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(pieceEvents.create).not.toHaveBeenCalled();
      });

      it("moves drafting to in_review and records a 'filed' event when owned", async () => {
        const piece = {
          ...PIECE,
          writerId: 'writer-1',
          stage: 'drafting' as const,
        };
        pieces.findOne.mockResolvedValue(piece);
        payments.findOne.mockResolvedValue(null);

        const result = await service.fileDraft('writer-1', 'piece-1');

        expect(piece.stage).toBe('in_review');
        expect(pieces.save).toHaveBeenCalledWith(piece);
        expect(pieceEvents.create).toHaveBeenCalledWith(
          expect.objectContaining({
            pieceId: 'piece-1',
            actorId: 'writer-1',
            action: 'filed',
          }),
        );
        expect(result.stage).toBe('in_review');
      });

      it('leaves the stage untouched when already past drafting/commissioned', async () => {
        const piece = {
          ...PIECE,
          writerId: 'writer-1',
          stage: 'in_review' as const,
        };
        pieces.findOne.mockResolvedValue(piece);
        payments.findOne.mockResolvedValue(null);

        await service.fileDraft('writer-1', 'piece-1');

        expect(piece.stage).toBe('in_review');
        expect(pieces.save).not.toHaveBeenCalled();
        expect(pieceEvents.create).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'filed' }),
        );
      });
    });
  });

  describe('listMagazineEditors', () => {
    it('returns only magazine_editor staff-role holders and admins, hand-mapped with no user-table leak', async () => {
      staffRoles.find.mockResolvedValue([
        {
          id: 'grant-1',
          userId: 'editor-1',
          role: 'magazine_editor',
          grantedById: null,
          grantedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]);
      users.find.mockResolvedValue([
        makeUser({ id: 'admin-1', role: UserRole.Admin }),
      ]);
      // A plain member who is neither an editor nor an admin has a profile
      // too, but must never surface here — proves the query, not just the
      // mapper, does the filtering.
      profiles.find.mockResolvedValue([
        makeProfile({
          userId: 'editor-1',
          firstName: 'Kai',
          lastName: 'Duarte',
        }),
        makeProfile({ userId: 'admin-1', firstName: 'Ana', lastName: 'Silva' }),
      ]);

      const result = await service.listMagazineEditors();

      expect(result.map((editor) => editor.id).sort()).toEqual(
        ['admin-1', 'editor-1'].sort(),
      );
      for (const editor of result) {
        expect(Object.keys(editor).sort()).toEqual(
          ['avatarUrl', 'id', 'initials', 'name'].sort(),
        );
        expect(editor).not.toHaveProperty('email');
        expect(editor).not.toHaveProperty('googleId');
        expect(editor).not.toHaveProperty('role');
      }
    });

    it('dedupes a user who is both an admin and a magazine_editor grant holder', async () => {
      staffRoles.find.mockResolvedValue([
        {
          id: 'grant-1',
          userId: 'admin-1',
          role: 'magazine_editor',
          grantedById: null,
          grantedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]);
      users.find.mockResolvedValue([
        makeUser({ id: 'admin-1', role: UserRole.Admin }),
      ]);
      profiles.find.mockResolvedValue([
        makeProfile({ userId: 'admin-1', firstName: 'Ana', lastName: 'Silva' }),
      ]);

      const result = await service.listMagazineEditors();

      expect(result).toHaveLength(1);
    });

    it('returns an empty array when nobody holds the role and there are no admins', async () => {
      staffRoles.find.mockResolvedValue([]);
      users.find.mockResolvedValue([]);

      const result = await service.listMagazineEditors();

      expect(result).toEqual([]);
      expect(profiles.find).not.toHaveBeenCalled();
    });
  });

  describe('getCurrentIssueSummary', () => {
    it('returns the highest-number issue with filled/slots derived from real data', async () => {
      issues.find.mockResolvedValue([
        {
          id: 'issue-1',
          number: '07',
          theme: 'Chosen family',
        } as MagazineIssue,
      ]);
      pieces.count.mockResolvedValue(3);
      sections.find.mockResolvedValue([
        { id: 's1', name: 'Cover', target: 1, note: '', orderIndex: 0 },
        { id: 's2', name: 'Features', target: 4, note: '', orderIndex: 1 },
      ]);

      const result = await service.getCurrentIssueSummary();

      expect(issues.find).toHaveBeenCalledWith(
        expect.objectContaining({ order: { number: 'DESC' }, take: 1 }),
      );
      expect(pieces.count).toHaveBeenCalledWith({
        where: { issueId: 'issue-1' },
      });
      expect(result).toEqual({
        id: 'issue-1',
        number: '07',
        theme: 'Chosen family',
        filled: 3,
        slots: 5,
      });
    });

    it('returns null when no issue exists yet', async () => {
      issues.find.mockResolvedValue([]);

      const result = await service.getCurrentIssueSummary();

      expect(result).toBeNull();
      expect(pieces.count).not.toHaveBeenCalled();
    });
  });

  describe('listPieces saved view v-art', () => {
    it('filters to pieces whose art is none or brief (still needs art)', async () => {
      const queryBuilder = {
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          { ...PIECE, id: 'piece-none', art: 'none' as const },
          { ...PIECE, id: 'piece-brief', art: 'brief' as const },
          { ...PIECE, id: 'piece-in', art: 'in' as const },
          { ...PIECE, id: 'piece-na', art: 'na' as const },
        ]),
      };
      pieces.createQueryBuilder.mockReturnValue(queryBuilder);

      const result = await service.listPieces({ savedView: 'v-art' });

      expect(result.map((item) => item.id).sort()).toEqual(
        ['piece-brief', 'piece-none'].sort(),
      );
    });
  });

  describe('searchArchive', () => {
    function makeQueryBuilder(rows: unknown[]) {
      return {
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
    }

    const PUBLISHED_ARTICLE = {
      ...ARTICLE,
      id: 'article-2',
      title: 'On chosen family',
      authorId: 'author-1',
      issueId: 'issue-1',
      tags: ['family'],
      publishedAt: new Date('2026-07-01T00:00:00.000Z'),
    };

    const PUBLISHED_DECK = {
      id: 'deck-1',
      slug: 'nightlife-map',
      title: 'Nightlife, mapped',
      kicker: '',
      section: 'Culture',
      byline: 'Sofia Andrade',
      role: null,
      authorBio: '',
      cover: '',
      coverDesc: '',
      readTime: '',
      tags: ['nightlife'],
      related: [],
      slides: [],
      publishedAt: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    } as MagazineDeck;

    it('returns matching published articles and decks, mapped and merged newest-first', async () => {
      articles.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([PUBLISHED_ARTICLE]),
      );
      decks.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([PUBLISHED_DECK]),
      );
      authors.find.mockResolvedValue([{ id: 'author-1', name: 'Kai Duarte' }]);
      issues.find.mockResolvedValue([{ id: 'issue-1', number: '05' }]);

      const result = await service.searchArchive('chosen');

      expect(result).toEqual([
        {
          title: 'On chosen family',
          issue: '05',
          by: 'Kai Duarte',
          tags: ['family'],
        },
        {
          title: 'Nightlife, mapped',
          issue: null,
          by: 'Sofia Andrade',
          tags: ['nightlife'],
        },
      ]);
    });

    it('excludes unpublished content — the query only ever loads published rows', async () => {
      const articleQueryBuilder = makeQueryBuilder([]);
      const deckQueryBuilder = makeQueryBuilder([]);
      articles.createQueryBuilder.mockReturnValue(articleQueryBuilder);
      decks.createQueryBuilder.mockReturnValue(deckQueryBuilder);

      const result = await service.searchArchive('anything');

      expect(articleQueryBuilder.where).toHaveBeenCalledWith(
        'article.published_at IS NOT NULL',
      );
      expect(deckQueryBuilder.where).toHaveBeenCalledWith(
        'deck.published_at IS NOT NULL',
      );
      expect(result).toEqual([]);
    });

    it('returns recent published items when the query is empty, skipping the text filter', async () => {
      const articleQueryBuilder = makeQueryBuilder([PUBLISHED_ARTICLE]);
      const deckQueryBuilder = makeQueryBuilder([]);
      articles.createQueryBuilder.mockReturnValue(articleQueryBuilder);
      decks.createQueryBuilder.mockReturnValue(deckQueryBuilder);
      authors.find.mockResolvedValue([{ id: 'author-1', name: 'Kai Duarte' }]);
      issues.find.mockResolvedValue([{ id: 'issue-1', number: '05' }]);

      const result = await service.searchArchive('');

      expect(articleQueryBuilder.andWhere).not.toHaveBeenCalled();
      expect(deckQueryBuilder.andWhere).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });
  });

  describe('listMagazineNotifications', () => {
    const PAYMENT_EVENT = {
      id: 'event-payment',
      pieceId: 'piece-1',
      actorId: 'editor-1',
      action: 'payment_updated',
      detail: null,
      createdAt: new Date('2026-08-09T09:00:00.000Z'),
    };

    const STAGE_EVENT = {
      id: 'event-stage',
      pieceId: 'piece-1',
      actorId: 'editor-1',
      action: 'stage_changed',
      detail: 'edit',
      createdAt: new Date('2026-08-08T09:00:00.000Z'),
    };

    function stubEditorDirectory() {
      staffRoles.find.mockResolvedValue([
        {
          id: 'grant-1',
          userId: 'editor-1',
          role: 'magazine_editor',
          grantedById: null,
          grantedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]);
      users.find.mockResolvedValue([]);
      profiles.find.mockResolvedValue([
        makeProfile({
          userId: 'editor-1',
          firstName: 'Marta',
          lastName: 'Reis',
        }),
      ]);
    }

    it('returns rows newest-first, limited to the requested count', async () => {
      stubEditorDirectory();
      pieceEvents.find.mockResolvedValue([PAYMENT_EVENT, STAGE_EVENT]);
      pieces.find.mockResolvedValue([
        { ...PIECE, id: 'piece-1', title: 'The chosen-family budget' },
      ]);

      const result = await service.listMagazineNotifications('editor-1', 2);

      expect(pieceEvents.find).toHaveBeenCalledWith(
        expect.objectContaining({
          order: { createdAt: 'DESC' },
          take: 2,
        }),
      );
      expect(result.map((row) => row.id)).toEqual([
        'event-payment',
        'event-stage',
      ]);
    });

    it("resolves the actor's name via the editor directory, never an email or raw uuid", async () => {
      stubEditorDirectory();
      pieceEvents.find.mockResolvedValue([STAGE_EVENT]);
      pieces.find.mockResolvedValue([
        { ...PIECE, id: 'piece-1', title: 'The chosen-family budget' },
      ]);

      const [notification] =
        await service.listMagazineNotifications('editor-1');

      expect(notification?.who).toBe('Marta Reis');
      expect(notification?.who).not.toContain('@');
      expect(notification?.who).not.toBe('editor-1');
    });

    it('resolves a non-editor actor (e.g. a writer) via a batched Profile lookup, not the editor-only fallback', async () => {
      // `listMagazineEditors()` (called first, inside the outer `Promise.all`)
      // makes its own `profiles.find` call to resolve editor-1's name; the
      // fallback lookup below is strictly a SECOND, later call — chain the
      // mock explicitly so each call gets the right rows regardless of
      // resolution order.
      staffRoles.find.mockResolvedValue([
        {
          id: 'grant-1',
          userId: 'editor-1',
          role: 'magazine_editor',
          grantedById: null,
          grantedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]);
      users.find.mockResolvedValue([]);
      profiles.find
        .mockResolvedValueOnce([
          makeProfile({
            userId: 'editor-1',
            firstName: 'Marta',
            lastName: 'Reis',
          }),
        ])
        .mockResolvedValueOnce([
          makeProfile({
            userId: 'writer-9',
            firstName: 'Nina',
            lastName: 'Costa',
          }),
        ]);
      pieceEvents.find.mockResolvedValue([
        { ...STAGE_EVENT, actorId: 'writer-9' },
        { ...PAYMENT_EVENT, id: 'event-payment-2', actorId: 'writer-9' },
      ]);
      pieces.find.mockResolvedValue([
        { ...PIECE, id: 'piece-1', title: 'The chosen-family budget' },
      ]);

      const [firstNotification, secondNotification] =
        await service.listMagazineNotifications('editor-1');

      // A writer's `filed`/payment action must attribute to the writer, not
      // misread as an editor's action — this was the misattribution bug.
      expect(firstNotification?.who).toBe('Nina Costa');
      expect(secondNotification?.who).toBe('Nina Costa');
      expect(firstNotification?.who).not.toBe('An editor');
      expect(firstNotification?.who).not.toBe('Someone on the team');
      expect(firstNotification?.who).not.toContain('writer-9');
      expect(firstNotification?.who).not.toContain('@');

      // Two notifications from the same unresolved actor must still cost
      // exactly ONE additional batched Profile query (on top of the editor
      // directory's own lookup) — never a per-event lookup.
      expect(profiles.find).toHaveBeenCalledTimes(2);
      expect(profiles.find).toHaveBeenNthCalledWith(2, {
        where: { userId: In(['writer-9']) },
      });
    });

    it('falls back to a role-neutral label when the actor cannot be resolved by either the editor directory or a Profile lookup', async () => {
      staffRoles.find.mockResolvedValue([]);
      users.find.mockResolvedValue([]);
      pieceEvents.find.mockResolvedValue([
        { ...STAGE_EVENT, actorId: 'ghost-9' },
      ]);
      pieces.find.mockResolvedValue([
        { ...PIECE, id: 'piece-1', title: 'The chosen-family budget' },
      ]);
      profiles.find.mockResolvedValue([]);

      const [notification] =
        await service.listMagazineNotifications('editor-1');

      expect(notification?.who).toBe('Someone on the team');
      expect(notification?.who).not.toContain('ghost-9');
      expect(notification?.who).not.toContain('@');
    });

    it("tags a payment event 'warn' and a stage-move event 'normal'", async () => {
      stubEditorDirectory();
      pieceEvents.find.mockResolvedValue([PAYMENT_EVENT, STAGE_EVENT]);
      pieces.find.mockResolvedValue([
        { ...PIECE, id: 'piece-1', title: 'The chosen-family budget' },
      ]);

      const [paymentRow, stageRow] =
        await service.listMagazineNotifications('editor-1');

      expect(paymentRow?.tone).toBe('warn');
      expect(stageRow?.tone).toBe('normal');
      expect(stageRow?.what).toContain('The chosen-family budget');
      expect(stageRow?.what).toContain('edit');
    });

    it('points route at the piece record', async () => {
      stubEditorDirectory();
      pieceEvents.find.mockResolvedValue([STAGE_EVENT]);
      pieces.find.mockResolvedValue([
        { ...PIECE, id: 'piece-1', title: 'The chosen-family budget' },
      ]);

      const [notification] =
        await service.listMagazineNotifications('editor-1');

      expect(notification?.route).toBe('/magazine/editor/piece/piece-1');
    });

    it('returns an empty array when the event log is empty', async () => {
      pieceEvents.find.mockResolvedValue([]);

      const result = await service.listMagazineNotifications('editor-1');

      expect(result).toEqual([]);
      expect(pieces.find).not.toHaveBeenCalled();
    });

    it('flags an event unread when the viewer has never dismissed the panel', async () => {
      stubEditorDirectory();
      pieceEvents.find.mockResolvedValue([STAGE_EVENT]);
      pieces.find.mockResolvedValue([
        { ...PIECE, id: 'piece-1', title: 'The chosen-family budget' },
      ]);
      notificationReads.findOne.mockResolvedValue(null);

      const [notification] =
        await service.listMagazineNotifications('editor-1');

      expect(notification?.isUnread).toBe(true);
    });

    it("flags an event unread when it happened after the viewer's last read", async () => {
      stubEditorDirectory();
      pieceEvents.find.mockResolvedValue([STAGE_EVENT]);
      pieces.find.mockResolvedValue([
        { ...PIECE, id: 'piece-1', title: 'The chosen-family budget' },
      ]);
      notificationReads.findOne.mockResolvedValue({
        actorId: 'editor-1',
        lastReadAt: new Date('2026-08-01T00:00:00.000Z'),
      });

      const [notification] =
        await service.listMagazineNotifications('editor-1');

      expect(notification?.isUnread).toBe(true);
    });

    it("flags an event read when it happened at or before the viewer's last read", async () => {
      stubEditorDirectory();
      pieceEvents.find.mockResolvedValue([STAGE_EVENT]);
      pieces.find.mockResolvedValue([
        { ...PIECE, id: 'piece-1', title: 'The chosen-family budget' },
      ]);
      notificationReads.findOne.mockResolvedValue({
        actorId: 'editor-1',
        lastReadAt: new Date('2026-08-09T00:00:00.000Z'),
      });

      const [notification] =
        await service.listMagazineNotifications('editor-1');

      expect(notification?.isUnread).toBe(false);
    });
  });

  describe('markNotificationsRead', () => {
    it('creates a new read-cursor row for a viewer who has never dismissed the panel', async () => {
      notificationReads.findOne.mockResolvedValue(null);

      await service.markNotificationsRead('editor-1');

      expect(notificationReads.create).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: 'editor-1' }),
      );
      expect(notificationReads.save).toHaveBeenCalled();
    });

    it("updates the viewer's existing read-cursor row instead of creating a second one", async () => {
      const existing = {
        actorId: 'editor-1',
        lastReadAt: new Date('2026-08-01T00:00:00.000Z'),
      };
      notificationReads.findOne.mockResolvedValue(existing);

      await service.markNotificationsRead('editor-1');

      expect(notificationReads.create).not.toHaveBeenCalled();
      expect(notificationReads.save).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: 'editor-1' }),
      );
      expect(existing.lastReadAt.getTime()).toBeGreaterThan(
        new Date('2026-08-01T00:00:00.000Z').getTime(),
      );
    });
  });

  describe('article comments (Magazine Desk Phase 7, Task D1)', () => {
    function stubSoleEditor() {
      staffRoles.find.mockResolvedValue([
        {
          id: 'grant-1',
          userId: 'editor-1',
          role: 'magazine_editor',
          grantedById: null,
          grantedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]);
      users.find.mockResolvedValue([]);
      profiles.find.mockResolvedValue([
        makeProfile({
          userId: 'editor-1',
          firstName: 'Marta',
          lastName: 'Reis',
        }),
      ]);
    }

    describe('listArticleComments', () => {
      it('returns an empty array when the piece has no article yet', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, articleId: null });

        const result = await service.listArticleComments('piece-1');

        expect(result).toEqual([]);
        expect(articleComments.find).not.toHaveBeenCalled();
      });

      it('throws NotFoundException when the piece does not exist', async () => {
        pieces.findOne.mockResolvedValue(null);

        await expect(
          service.listArticleComments('missing'),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('returns a nested tree with resolved author names and no leak', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, articleId: 'article-1' });
        stubSoleEditor();
        const topComment = {
          id: 'comment-1',
          articleId: 'article-1',
          blockId: null,
          parentId: null,
          authorId: 'editor-1',
          body: 'Nice lede.',
          resolved: false,
          createdAt: new Date('2026-08-09T09:00:00Z'),
        };
        const reply = {
          id: 'comment-2',
          articleId: 'article-1',
          blockId: null,
          parentId: 'comment-1',
          authorId: 'editor-1',
          body: 'Agreed.',
          resolved: false,
          createdAt: new Date('2026-08-09T10:00:00Z'),
        };
        articleComments.find.mockResolvedValue([topComment, reply]);

        const result = await service.listArticleComments('piece-1');

        expect(articleComments.find).toHaveBeenCalledWith({
          where: { articleId: 'article-1' },
        });
        expect(result).toHaveLength(1);
        expect(result[0]?.author).toBe('Marta Reis');
        expect(result[0]?.author).not.toContain('@');
        expect(result[0]?.replies).toHaveLength(1);
        expect(result[0]?.replies[0]?.author).toBe('Marta Reis');
      });

      it('resolves a non-editor author (e.g. a writer) via a batched Profile lookup', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, articleId: 'article-1' });
        staffRoles.find.mockResolvedValue([]);
        users.find.mockResolvedValue([]);
        profiles.find.mockResolvedValue([
          makeProfile({
            userId: 'writer-9',
            firstName: 'Nina',
            lastName: 'Costa',
          }),
        ]);
        articleComments.find.mockResolvedValue([
          {
            id: 'comment-1',
            articleId: 'article-1',
            blockId: null,
            parentId: null,
            authorId: 'writer-9',
            body: 'Should we cut this?',
            resolved: false,
            createdAt: new Date('2026-08-09T09:00:00Z'),
          },
        ]);

        const [comment] = await service.listArticleComments('piece-1');

        expect(comment?.author).toBe('Nina Costa');
        expect(comment?.author).not.toContain('writer-9');
      });
    });

    describe('addArticleComment', () => {
      it('creates a top-level comment on the existing article and records a commented event', async () => {
        const piece = { ...PIECE, articleId: 'article-1' };
        pieces.findOne.mockResolvedValue(piece);
        articles.findOne.mockResolvedValue({ ...ARTICLE, id: 'article-1' });
        stubSoleEditor();
        articleComments.save.mockImplementation(
          (entity: MagazineArticleComment) => {
            entity.id = entity.id ?? 'comment-new';
            entity.createdAt =
              entity.createdAt ?? new Date('2026-08-10T09:00:00Z');
            return Promise.resolve(entity);
          },
        );

        const dto = { body: 'Watch this transition.', blockId: 'block-1' };
        const result = await service.addArticleComment(
          'piece-1',
          'editor-1',
          dto,
        );

        expect(articleComments.create).toHaveBeenCalledWith(
          expect.objectContaining({
            articleId: 'article-1',
            blockId: 'block-1',
            parentId: null,
            authorId: 'editor-1',
            body: 'Watch this transition.',
            resolved: false,
          }),
        );
        expect(pieceEvents.create).toHaveBeenCalledWith(
          expect.objectContaining({
            pieceId: 'piece-1',
            actorId: 'editor-1',
            action: 'commented',
          }),
        );
        expect(result.parentId).toBeNull();
        expect(result.replies).toEqual([]);
        expect(result.author).toBe('Marta Reis');
      });

      it('auto-creates the article draft first when the piece has none yet', async () => {
        const piece = { ...PIECE, articleId: null };
        pieces.findOne.mockResolvedValue(piece);
        articles.save.mockImplementation((entity: MagazineArticle) => {
          entity.id = 'article-1';
          return Promise.resolve(entity);
        });
        stubSoleEditor();
        articleComments.save.mockImplementation(
          (entity: MagazineArticleComment) => {
            entity.id = entity.id ?? 'comment-new';
            entity.createdAt =
              entity.createdAt ?? new Date('2026-08-10T09:00:00Z');
            return Promise.resolve(entity);
          },
        );

        await service.addArticleComment('piece-1', 'editor-1', {
          body: 'First note.',
        });

        expect(piece.articleId).toBe('article-1');
        expect(articleComments.create).toHaveBeenCalledWith(
          expect.objectContaining({ articleId: 'article-1' }),
        );
      });

      it('throws NotFoundException when the piece does not exist', async () => {
        pieces.findOne.mockResolvedValue(null);

        await expect(
          service.addArticleComment('missing', 'editor-1', {
            body: 'hello',
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    describe('replyToArticleComment', () => {
      it('creates a reply inheriting the parent articleId, with no blockId of its own', async () => {
        const parent = {
          id: 'comment-1',
          articleId: 'article-1',
          blockId: 'block-1',
          parentId: null,
          authorId: 'editor-1',
          body: 'Original note.',
          resolved: false,
          createdAt: new Date('2026-08-09T09:00:00Z'),
        };
        articleComments.findOne.mockResolvedValue(parent);
        stubSoleEditor();
        articleComments.save.mockImplementation(
          (entity: MagazineArticleComment) => {
            entity.id = entity.id ?? 'reply-1';
            entity.createdAt =
              entity.createdAt ?? new Date('2026-08-10T09:00:00Z');
            return Promise.resolve(entity);
          },
        );

        const result = await service.replyToArticleComment(
          'comment-1',
          'editor-1',
          { body: 'Good point.' },
        );

        expect(articleComments.create).toHaveBeenCalledWith(
          expect.objectContaining({
            articleId: 'article-1',
            blockId: null,
            parentId: 'comment-1',
            authorId: 'editor-1',
            body: 'Good point.',
          }),
        );
        expect(result.parentId).toBe('comment-1');
      });

      it('throws NotFoundException when the parent comment does not exist', async () => {
        articleComments.findOne.mockResolvedValue(null);

        await expect(
          service.replyToArticleComment('missing', 'editor-1', {
            body: 'hi',
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(articleComments.save).not.toHaveBeenCalled();
      });
    });

    describe('resolveArticleComment', () => {
      it('sets resolved to true and back to false idempotently', async () => {
        const comment = {
          id: 'comment-1',
          articleId: 'article-1',
          blockId: null,
          parentId: null,
          authorId: 'editor-1',
          body: 'Fix this.',
          resolved: false,
          createdAt: new Date('2026-08-09T09:00:00Z'),
        };
        articleComments.findOne.mockResolvedValue(comment);
        stubSoleEditor();

        const resolved = await service.resolveArticleComment('comment-1', {
          resolved: true,
        });
        expect(resolved.resolved).toBe(true);

        const reopened = await service.resolveArticleComment('comment-1', {
          resolved: false,
        });
        expect(reopened.resolved).toBe(false);
      });

      it('throws NotFoundException when the comment does not exist', async () => {
        articleComments.findOne.mockResolvedValue(null);

        await expect(
          service.resolveArticleComment('missing', { resolved: true }),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });
  });

  describe('article versions (Magazine Desk Phase 7, Task E1)', () => {
    function stubSoleEditor() {
      staffRoles.find.mockResolvedValue([
        {
          id: 'grant-1',
          userId: 'editor-1',
          role: 'magazine_editor',
          grantedById: null,
          grantedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]);
      users.find.mockResolvedValue([]);
      profiles.find.mockResolvedValue([
        makeProfile({
          userId: 'editor-1',
          firstName: 'Marta',
          lastName: 'Reis',
        }),
      ]);
    }

    function stubArticleVersionSave() {
      articleVersions.save.mockImplementation(
        (entity: MagazineArticleVersion) => {
          entity.id = entity.id ?? `version-${Math.random()}`;
          entity.createdAt = entity.createdAt ?? new Date();
          return Promise.resolve(entity);
        },
      );
    }

    describe('listArticleVersions', () => {
      it('returns an empty array when the piece has no article yet', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, articleId: null });

        const result = await service.listArticleVersions('piece-1');

        expect(result).toEqual([]);
        expect(articleVersions.find).not.toHaveBeenCalled();
      });

      it('throws NotFoundException when the piece does not exist', async () => {
        pieces.findOne.mockResolvedValue(null);

        await expect(
          service.listArticleVersions('missing'),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('lists versions newest-first with resolved author names and no blocks payload', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, articleId: 'article-1' });
        stubSoleEditor();
        articleVersions.find.mockResolvedValue([
          {
            id: 'version-2',
            articleId: 'article-1',
            label: 'Manual save',
            authorId: 'editor-1',
            blocks: [{ id: 'b1', kind: 'paragraph', html: 'Newer.' }],
            createdAt: new Date('2026-08-10T09:00:00Z'),
          },
          {
            id: 'version-1',
            articleId: 'article-1',
            label: 'Filed draft',
            authorId: 'editor-1',
            blocks: [{ id: 'b1', kind: 'paragraph', html: 'Older.' }],
            createdAt: new Date('2026-08-09T09:00:00Z'),
          },
        ]);

        const result = await service.listArticleVersions('piece-1');

        expect(articleVersions.find).toHaveBeenCalledWith({
          where: { articleId: 'article-1' },
          order: { createdAt: 'DESC' },
        });
        expect(result.map((version) => version.id)).toEqual([
          'version-2',
          'version-1',
        ]);
        expect(result[0]?.author).toBe('Marta Reis');
        for (const version of result) {
          expect(version).not.toHaveProperty('blocks');
        }
      });
    });

    describe('getArticleVersion', () => {
      it('throws NotFoundException when the version does not exist', async () => {
        articleVersions.findOne.mockResolvedValue(null);

        await expect(
          service.getArticleVersion('missing'),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('returns the full blocks snapshot alongside the resolved author', async () => {
        stubSoleEditor();
        articleVersions.findOne.mockResolvedValue({
          id: 'version-1',
          articleId: 'article-1',
          label: 'Manual save',
          authorId: 'editor-1',
          blocks: [{ id: 'b1', kind: 'paragraph', html: 'Hello.' }],
          createdAt: new Date('2026-08-09T09:00:00Z'),
        });

        const result = await service.getArticleVersion('version-1');

        expect(result.blocks).toEqual([
          { id: 'b1', kind: 'paragraph', html: 'Hello.' },
        ]);
        expect(result.author).toBe('Marta Reis');
      });
    });

    describe('createArticleVersion', () => {
      it("snapshots the article's current blocks under the default 'Manual save' label", async () => {
        const piece = { ...PIECE, articleId: 'article-1' };
        pieces.findOne.mockResolvedValue(piece);
        const article = {
          ...ARTICLE,
          id: 'article-1',
          blocks: [{ id: 'b1', kind: 'paragraph', html: 'Current text.' }],
        };
        articles.findOne.mockResolvedValue(article);
        stubSoleEditor();
        stubArticleVersionSave();

        const result = await service.createArticleVersion(
          'piece-1',
          'editor-1',
        );

        expect(articleVersions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            articleId: 'article-1',
            label: 'Manual save',
            authorId: 'editor-1',
            blocks: [{ id: 'b1', kind: 'paragraph', html: 'Current text.' }],
          }),
        );
        expect(result.label).toBe('Manual save');
        expect(result.author).toBe('Marta Reis');
      });

      it('honors an explicit label when provided', async () => {
        const piece = { ...PIECE, articleId: 'article-1' };
        pieces.findOne.mockResolvedValue(piece);
        articles.findOne.mockResolvedValue({ ...ARTICLE, id: 'article-1' });
        stubSoleEditor();
        stubArticleVersionSave();

        const result = await service.createArticleVersion(
          'piece-1',
          'editor-1',
          'Before big rewrite',
        );

        expect(result.label).toBe('Before big rewrite');
      });

      it('auto-creates the article draft first when the piece has none yet', async () => {
        const piece = { ...PIECE, articleId: null };
        pieces.findOne.mockResolvedValue(piece);
        articles.save.mockImplementation((entity: MagazineArticle) => {
          entity.id = 'article-1';
          return Promise.resolve(entity);
        });
        stubSoleEditor();
        stubArticleVersionSave();

        await service.createArticleVersion('piece-1', 'editor-1');

        expect(piece.articleId).toBe('article-1');
        expect(articleVersions.create).toHaveBeenCalledWith(
          expect.objectContaining({ articleId: 'article-1' }),
        );
      });
    });

    describe('restoreArticleVersion', () => {
      it('throws NotFoundException when the piece does not exist', async () => {
        pieces.findOne.mockResolvedValue(null);

        await expect(
          service.restoreArticleVersion('missing', 'version-1', 'editor-1'),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('throws NotFoundException when the piece has no article yet', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, articleId: null });

        await expect(
          service.restoreArticleVersion('piece-1', 'version-1', 'editor-1'),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('throws NotFoundException when the version does not exist', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, articleId: 'article-1' });
        articleVersions.findOne.mockResolvedValue(null);

        await expect(
          service.restoreArticleVersion('piece-1', 'missing', 'editor-1'),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('throws NotFoundException when the version belongs to a different article', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, articleId: 'article-1' });
        articleVersions.findOne.mockResolvedValue({
          id: 'version-1',
          articleId: 'some-other-article',
          label: 'Manual save',
          authorId: 'editor-1',
          blocks: [],
          createdAt: new Date('2026-08-09T09:00:00Z'),
        });

        await expect(
          service.restoreArticleVersion('piece-1', 'version-1', 'editor-1'),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(articles.save).not.toHaveBeenCalled();
      });

      it('copies the version blocks back onto the article and records both a "Before restore" and a "Restored from…" version, losing nothing', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, articleId: 'article-1' });
        const versionBlocks = [
          { id: 'b1', kind: 'paragraph', html: 'Old text.' },
        ];
        const version = {
          id: 'version-1',
          articleId: 'article-1',
          label: 'Filed draft',
          authorId: 'writer-1',
          blocks: versionBlocks,
          createdAt: new Date('2026-08-05T09:00:00Z'),
        };
        articleVersions.findOne.mockResolvedValue(version);
        const article = {
          ...ARTICLE,
          id: 'article-1',
          blocks: [{ id: 'b2', kind: 'paragraph', html: 'Current text.' }],
        };
        articles.findOne.mockResolvedValue(article);
        stubArticleVersionSave();

        const result = await service.restoreArticleVersion(
          'piece-1',
          'version-1',
          'editor-1',
        );

        // The article now carries the restored blocks.
        expect(article.blocks).toEqual(versionBlocks);
        expect(articles.save).toHaveBeenCalledWith(article);
        expect(result.blocks).toEqual(versionBlocks);

        // Nothing is lost: the pre-restore state and the restore itself both
        // became new versions.
        expect(articleVersions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            articleId: 'article-1',
            label: 'Before restore',
            authorId: 'editor-1',
            blocks: [{ id: 'b2', kind: 'paragraph', html: 'Current text.' }],
          }),
        );
        expect(articleVersions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            articleId: 'article-1',
            label: 'Restored from 2026-08-05',
            authorId: 'editor-1',
            blocks: versionBlocks,
          }),
        );
        expect(articleVersions.save).toHaveBeenCalledTimes(2);

        // The audit trail records the restore.
        expect(pieceEvents.create).toHaveBeenCalledWith(
          expect.objectContaining({
            pieceId: 'piece-1',
            actorId: 'editor-1',
            action: 'version_restored',
          }),
        );
      });

      it('copies the blocks by value — mutating the source version afterward never changes the restored article', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, articleId: 'article-1' });
        const versionBlocks = [
          { id: 'b1', kind: 'paragraph', html: 'Old text.' },
        ];
        const version = {
          id: 'version-1',
          articleId: 'article-1',
          label: 'Filed draft',
          authorId: 'writer-1',
          blocks: versionBlocks,
          createdAt: new Date('2026-08-05T09:00:00Z'),
        };
        articleVersions.findOne.mockResolvedValue(version);
        const article = { ...ARTICLE, id: 'article-1', blocks: [] };
        articles.findOne.mockResolvedValue(article);
        stubArticleVersionSave();

        await service.restoreArticleVersion('piece-1', 'version-1', 'editor-1');

        (versionBlocks[0] as { html: string }).html = 'Mutated after restore.';

        expect((article.blocks[0] as unknown as { html: string }).html).toBe(
          'Old text.',
        );
      });

      it('rejects a malformed version blocks snapshot rather than saving it', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, articleId: 'article-1' });
        articleVersions.findOne.mockResolvedValue({
          id: 'version-1',
          articleId: 'article-1',
          label: 'Filed draft',
          authorId: 'writer-1',
          blocks: [{ id: 'b1', kind: 'paragraph' }],
          createdAt: new Date('2026-08-05T09:00:00Z'),
        });
        articles.findOne.mockResolvedValue({ ...ARTICLE, id: 'article-1' });
        stubArticleVersionSave();

        await expect(
          service.restoreArticleVersion('piece-1', 'version-1', 'editor-1'),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(articles.save).not.toHaveBeenCalled();
        expect(articleVersions.create).not.toHaveBeenCalled();
      });
    });

    describe('fileDraft auto-snapshot', () => {
      it("records a 'Filed draft' version when the piece has a linked article", async () => {
        const piece = {
          ...PIECE,
          writerId: 'writer-1',
          stage: 'drafting' as const,
          articleId: 'article-1',
        };
        pieces.findOne.mockResolvedValue(piece);
        payments.findOne.mockResolvedValue(null);
        const article = { ...ARTICLE, id: 'article-1' };
        articles.findOne.mockResolvedValue(article);
        stubArticleVersionSave();

        await service.fileDraft('writer-1', 'piece-1');

        expect(articleVersions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            articleId: 'article-1',
            label: 'Filed draft',
            authorId: 'writer-1',
          }),
        );
      });

      it('skips the snapshot (never crashes) when the piece has no article yet', async () => {
        const piece = {
          ...PIECE,
          writerId: 'writer-1',
          stage: 'drafting' as const,
          articleId: null,
        };
        pieces.findOne.mockResolvedValue(piece);
        payments.findOne.mockResolvedValue(null);

        await expect(
          service.fileDraft('writer-1', 'piece-1'),
        ).resolves.toBeDefined();
        expect(articleVersions.create).not.toHaveBeenCalled();
        expect(articles.findOne).not.toHaveBeenCalled();
      });
    });
  });

  describe('piece message thread (Magazine Desk Phase 7, Task F1)', () => {
    // SECURITY IS THE THEME — every test here proves the access rule:
    // (a) the editor/admin surface (isEditor: true) OR (b) the piece's own
    // assigned writer (`piece.writerId === userId`), Forbidden otherwise.
    function stubSoleEditor() {
      staffRoles.find.mockResolvedValue([
        {
          id: 'grant-1',
          userId: 'editor-1',
          role: 'magazine_editor',
          grantedById: null,
          grantedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]);
      users.find.mockResolvedValue([]);
      profiles.find.mockResolvedValue([
        makeProfile({
          userId: 'editor-1',
          firstName: 'Marta',
          lastName: 'Reis',
        }),
      ]);
    }

    function makeMessage(
      overrides: Partial<MagazinePieceMessage> = {},
    ): MagazinePieceMessage {
      return {
        id: 'message-1',
        pieceId: 'piece-1',
        authorId: 'editor-1',
        body: 'Any update on the draft?',
        createdAt: new Date('2026-08-09T09:00:00Z'),
        ...overrides,
      };
    }

    describe('listPieceMessages', () => {
      it('throws ForbiddenException for a writer who is NOT assigned to the piece', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, writerId: 'writer-1' });

        await expect(
          service.listPieceMessages('piece-1', 'writer-2', false),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(pieceMessages.find).not.toHaveBeenCalled();
      });

      it('throws NotFoundException when the piece does not exist', async () => {
        pieces.findOne.mockResolvedValue(null);

        await expect(
          service.listPieceMessages('missing', 'writer-1', false),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('succeeds for the assigned writer', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, writerId: 'writer-1' });
        stubSoleEditor();
        pieceMessages.find.mockResolvedValue([makeMessage()]);

        await expect(
          service.listPieceMessages('piece-1', 'writer-1', false),
        ).resolves.toHaveLength(1);
      });

      it('succeeds for the editor regardless of which writer is assigned', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, writerId: 'writer-1' });
        stubSoleEditor();
        pieceMessages.find.mockResolvedValue([makeMessage()]);

        await expect(
          service.listPieceMessages('piece-1', 'editor-1', true),
        ).resolves.toHaveLength(1);
      });

      it('orders the thread oldest first, resolves author names, and computes fromMe against the requester', async () => {
        pieces.findOne.mockResolvedValue({
          ...PIECE,
          editorId: 'editor-1',
          writerId: 'writer-1',
        });
        staffRoles.find.mockResolvedValue([
          {
            id: 'grant-1',
            userId: 'editor-1',
            role: 'magazine_editor',
            grantedById: null,
            grantedAt: new Date('2026-08-01T00:00:00.000Z'),
          },
        ]);
        users.find.mockResolvedValue([]);
        profiles.find.mockResolvedValue([
          makeProfile({
            userId: 'editor-1',
            firstName: 'Marta',
            lastName: 'Reis',
          }),
          makeProfile({
            userId: 'writer-1',
            firstName: 'Kai',
            lastName: 'Duarte',
          }),
        ]);
        const fromEditor = makeMessage({
          id: 'message-1',
          authorId: 'editor-1',
          createdAt: new Date('2026-08-09T09:00:00Z'),
        });
        const fromWriter = makeMessage({
          id: 'message-2',
          authorId: 'writer-1',
          createdAt: new Date('2026-08-09T10:00:00Z'),
        });
        pieceMessages.find.mockResolvedValue([fromEditor, fromWriter]);

        const result = await service.listPieceMessages(
          'piece-1',
          'writer-1',
          false,
        );

        expect(pieceMessages.find).toHaveBeenCalledWith({
          where: { pieceId: 'piece-1' },
          order: { createdAt: 'ASC' },
        });
        expect(result.map((message) => message.id)).toEqual([
          'message-1',
          'message-2',
        ]);
        expect(result[0]?.author).toBe('Marta Reis');
        expect(result[0]?.fromMe).toBe(false);
        expect(result[1]?.author).toBe('Kai Duarte');
        expect(result[1]?.fromMe).toBe(true);
        expect(JSON.stringify(result)).not.toContain('editor-1');
        expect(JSON.stringify(result)).not.toContain('writer-1');
      });
    });

    describe('postPieceMessage', () => {
      it('throws ForbiddenException for a writer who is NOT assigned to the piece', async () => {
        pieces.findOne.mockResolvedValue({ ...PIECE, writerId: 'writer-1' });

        await expect(
          service.postPieceMessage('piece-1', 'writer-2', false, {
            body: 'Let me in?',
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(pieceMessages.save).not.toHaveBeenCalled();
        expect(notifications.create).not.toHaveBeenCalled();
      });

      it('succeeds for the assigned writer and notifies the assigned editor (the OTHER party)', async () => {
        const piece = {
          ...PIECE,
          editorId: 'editor-1',
          writerId: 'writer-1',
        };
        pieces.findOne.mockResolvedValue(piece);
        stubSoleEditor();
        pieceMessages.save.mockImplementation(
          (entity: MagazinePieceMessage) => {
            entity.id = entity.id ?? 'message-new';
            entity.createdAt =
              entity.createdAt ?? new Date('2026-08-10T09:00:00Z');
            return Promise.resolve(entity);
          },
        );

        const result = await service.postPieceMessage(
          'piece-1',
          'writer-1',
          false,
          { body: 'Filed the draft, take a look.' },
        );

        expect(pieceMessages.create).toHaveBeenCalledWith(
          expect.objectContaining({
            pieceId: 'piece-1',
            authorId: 'writer-1',
            body: 'Filed the draft, take a look.',
          }),
        );
        // The OTHER party is notified — the writer posted, so the target is
        // the piece's assigned EDITOR, never the writer themself.
        expect(notifications.create).toHaveBeenCalledWith(
          'editor-1',
          NotificationType.MagazinePieceMessage,
          expect.objectContaining({ pieceId: 'piece-1' }),
          'writer-1',
        );
        expect(result.fromMe).toBe(true);
      });

      it('succeeds for the editor and notifies the assigned writer (the OTHER party)', async () => {
        const piece = {
          ...PIECE,
          editorId: 'editor-1',
          writerId: 'writer-1',
        };
        pieces.findOne.mockResolvedValue(piece);
        stubSoleEditor();
        pieceMessages.save.mockImplementation(
          (entity: MagazinePieceMessage) => {
            entity.id = entity.id ?? 'message-new';
            entity.createdAt =
              entity.createdAt ?? new Date('2026-08-10T09:00:00Z');
            return Promise.resolve(entity);
          },
        );

        await service.postPieceMessage('piece-1', 'editor-1', true, {
          body: 'Chasing your draft — any update?',
        });

        // The OTHER party is notified — the editor posted, so the target is
        // the piece's assigned WRITER, never the editor themself.
        expect(notifications.create).toHaveBeenCalledWith(
          'writer-1',
          NotificationType.MagazinePieceMessage,
          expect.objectContaining({ pieceId: 'piece-1' }),
          'editor-1',
        );
      });

      it('skips the notification (never crashes) when the piece has no assigned writer', async () => {
        const piece = { ...PIECE, editorId: 'editor-1', writerId: null };
        pieces.findOne.mockResolvedValue(piece);
        stubSoleEditor();
        pieceMessages.save.mockImplementation(
          (entity: MagazinePieceMessage) => {
            entity.id = entity.id ?? 'message-new';
            entity.createdAt =
              entity.createdAt ?? new Date('2026-08-10T09:00:00Z');
            return Promise.resolve(entity);
          },
        );

        await expect(
          service.postPieceMessage('piece-1', 'editor-1', true, {
            body: 'Note to self, no writer yet.',
          }),
        ).resolves.toBeDefined();
        expect(notifications.create).not.toHaveBeenCalled();
      });

      it('still returns the saved message when the notification write fails (best-effort, never fails the post)', async () => {
        const piece = {
          ...PIECE,
          editorId: 'editor-1',
          writerId: 'writer-1',
        };
        pieces.findOne.mockResolvedValue(piece);
        stubSoleEditor();
        pieceMessages.save.mockImplementation(
          (entity: MagazinePieceMessage) => {
            entity.id = entity.id ?? 'message-new';
            entity.createdAt =
              entity.createdAt ?? new Date('2026-08-10T09:00:00Z');
            return Promise.resolve(entity);
          },
        );
        notifications.create.mockRejectedValueOnce(new Error('insert failed'));

        const result = await service.postPieceMessage(
          'piece-1',
          'writer-1',
          false,
          { body: 'Filed the draft, take a look.' },
        );

        expect(pieceMessages.save).toHaveBeenCalled();
        expect(result.fromMe).toBe(true);
      });
    });
  });
});
