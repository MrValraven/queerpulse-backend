import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { IdentitiesService } from '../identities/identities.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Message } from '../messaging/entities/message.entity';
import { MetricsService } from '../metrics/metrics.service';
import { QUIZSHOW_ANSWER_SNAPSHOT_TYPE } from '../quizshow/quizshow.contract';
import { Report, ReportSubjectType } from './entities/report.entity';
import { ReportsService } from './reports.service';

// Pulse Live: an answer report names an answer by its uuid.
const ANSWER_ID = '9d000000-0000-4000-8000-0000000000cc';
const QUESTION_ID = '9d000000-0000-4000-8000-0000000000dd';
const OPENED_AT = Date.parse('2026-10-19T20:00:00.000Z');
const REVEALED_AT = Date.parse('2026-10-19T20:00:30.000Z');

const answerRow = (overrides: Record<string, unknown> = {}) => ({
  id: ANSWER_ID,
  session_id: 'session-1',
  question_id: QUESTION_ID,
  event_id: 'event-1',
  event_slug: 'pulse-live-night',
  text: 'A very rude answer',
  received_at: new Date('2026-10-19T20:00:10.000Z'),
  hidden_at: null,
  author_screen_name: 'Glitter',
  author_user_id: 'author-1',
  question_log: [
    {
      questionId: QUESTION_ID,
      openedAt: OPENED_AT,
      revealedAt: REVEALED_AT,
    },
  ],
  quiz_snapshot: {
    rounds: [
      {
        kind: 'party_prompt',
        questions: [
          { id: QUESTION_ID, prompt: { en: 'Name a drag queen', pt: 'Nome' } },
        ],
      },
    ],
  },
  is_organiser: false,
  reporter_joined_at: new Date(OPENED_AT - 60000),
  quiz_id: 'quiz-1',
  owner_user_id: null,
  ...overrides,
});

describe('ReportsService: the Pulse Live answer subject', () => {
  let service: ReportsService;
  let reports: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    manager: { query: jest.Mock };
  };

  beforeEach(async () => {
    reports = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: object) => value),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((row: unknown) =>
        Promise.resolve({
          id: 'report-1',
          createdAt: new Date('2026-10-19T21:00:00.000Z'),
          ...(row as object),
        }),
      ),
      manager: { query: jest.fn().mockResolvedValue([answerRow()]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: getRepositoryToken(Report), useValue: reports },
        {
          provide: getRepositoryToken(Message),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: getRepositoryToken(HousingListing),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: getRepositoryToken(EventPhoto),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: getRepositoryToken(Conversation),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: getRepositoryToken(ConversationParticipant),
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
            find: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: getRepositoryToken(ContentModeration),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        { provide: IdentitiesService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: MetricsService,
          useValue: { incrementReportFloodRefusal: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  const fileAgainst = (subjectId: string, reporterId = 'reporter-1') =>
    service.create(reporterId, {
      subjectType: ReportSubjectType.QuizshowAnswer,
      subjectId,
      reasonCode: 'harassment',
    });

  it('files a report on a revealed answer and keeps a snapshot of it', async () => {
    await fileAgainst(ANSWER_ID);
    const created = reports.create.mock.calls[0][0] as {
      evidence: Array<Record<string, unknown>>;
    };
    expect(created.evidence).toHaveLength(1);
    expect(created.evidence[0]).toEqual(
      expect.objectContaining({
        type: QUIZSHOW_ANSWER_SNAPSHOT_TYPE,
        answerId: ANSWER_ID,
        text: 'A very rude answer',
        authorScreenName: 'Glitter',
        roundKind: 'party_prompt',
        wasHidden: false,
      }),
    );
  });

  it('lowercases the answer id before the dedupe', async () => {
    await fileAgainst(ANSWER_ID.toUpperCase());
    expect(reports.manager.query).toHaveBeenCalledWith(expect.any(String), [
      ANSWER_ID,
      'reporter-1',
    ]);
    expect(reports.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ subjectId: ANSWER_ID }),
      }),
    );
  });

  it('answers 404 to a member who never saw the answer', async () => {
    reports.manager.query.mockResolvedValue([
      answerRow({ reporter_joined_at: new Date(OPENED_AT + 1000) }),
    ]);
    await expect(fileAgainst(ANSWER_ID)).rejects.toThrow(
      new NotFoundException('Answer not found'),
    );
    reports.manager.query.mockResolvedValue([
      answerRow({ hidden_at: new Date(REVEALED_AT - 1000) }),
    ]);
    await expect(fileAgainst(ANSWER_ID)).rejects.toThrow(
      new NotFoundException('Answer not found'),
    );
    expect(reports.save).not.toHaveBeenCalled();
  });

  it('answers 404 to the author', async () => {
    await expect(fileAgainst(ANSWER_ID, 'author-1')).rejects.toThrow(
      new NotFoundException('Answer not found'),
    );
    expect(reports.save).not.toHaveBeenCalled();
  });

  it('answers 404 for a malformed id without a query', async () => {
    await expect(fileAgainst('not-a-uuid')).rejects.toThrow(
      new NotFoundException('Answer not found'),
    );
    expect(reports.manager.query).not.toHaveBeenCalled();
  });

  it('lets an organiser report an answer hidden during review', async () => {
    reports.manager.query.mockResolvedValue([
      answerRow({
        is_organiser: true,
        reporter_joined_at: null,
        hidden_at: new Date(OPENED_AT + 5000),
        question_log: [
          { questionId: QUESTION_ID, openedAt: OPENED_AT, revealedAt: null },
        ],
      }),
    ]);
    await fileAgainst(ANSWER_ID, 'organiser-1');
    const created = reports.create.mock.calls[0][0] as {
      evidence: Array<Record<string, unknown>>;
    };
    expect(created.evidence[0]).toEqual(
      expect.objectContaining({ wasHidden: true }),
    );
  });

  it('lets the game owner report an answer in their game', async () => {
    reports.manager.query.mockResolvedValue([
      answerRow({
        event_id: null,
        event_slug: null,
        quiz_id: 'game-1',
        owner_user_id: 'owner-1',
        is_organiser: true,
        reporter_joined_at: null,
        question_log: [
          { questionId: QUESTION_ID, openedAt: OPENED_AT, revealedAt: null },
        ],
      }),
    ]);
    await fileAgainst(ANSWER_ID, 'owner-1');
    const sql = reports.manager.query.mock.calls[0][0] as string;
    expect(sql).toContain(
      'JOIN "quizshow_quizzes" "quiz" ON "quiz"."id" = "session"."quiz_id"',
    );
    expect(sql).toContain('LEFT JOIN "events" "event"');
    expect(sql).toContain('"quiz"."owner_user_id" = $2');
    expect(reports.save).toHaveBeenCalledTimes(1);
  });

  it('fills gameId and leaves the event fields null for a game answer', async () => {
    reports.manager.query.mockResolvedValue([
      answerRow({
        event_id: null,
        event_slug: null,
        quiz_id: 'game-1',
        owner_user_id: 'owner-1',
      }),
    ]);
    await fileAgainst(ANSWER_ID);
    const created = reports.create.mock.calls[0][0] as {
      evidence: Array<Record<string, unknown>>;
    };
    expect(created.evidence[0]).toEqual(
      expect.objectContaining({
        type: QUIZSHOW_ANSWER_SNAPSHOT_TYPE,
        eventId: null,
        eventSlug: null,
        gameId: 'game-1',
      }),
    );
  });
});
