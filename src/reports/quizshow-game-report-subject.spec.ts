import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { EntityManager } from 'typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { IdentitiesService } from '../identities/identities.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Message } from '../messaging/entities/message.entity';
import { MetricsService } from '../metrics/metrics.service';
import { captureQuizshowGameForReport } from '../quizshow/quizshow-game-report';
import { QUIZSHOW_GAME_SNAPSHOT_TYPE } from '../quizshow/quizshow.contract';
import { Report, ReportSubjectType } from './entities/report.entity';
import { ReportsService } from './reports.service';

// Pulse Live: a game report names a game session by its uuid.
const SESSION_ID = '9d000000-0000-4000-8000-0000000000aa';
const GAME_ID = '9d000000-0000-4000-8000-0000000000bb';
const FIRST_QUESTION_ID = 'question-1';
const SECOND_QUESTION_ID = 'question-2';
const THIRD_QUESTION_ID = 'question-3';
const CAPTURED_AT = new Date('2026-10-20T21:00:00.000Z');

const quizSnapshot = {
  title: 'Friday Pulse Live',
  languages: 'both',
  screenLanguage: 'en',
  rounds: [
    {
      kind: 'quiz',
      questions: [
        {
          id: FIRST_QUESTION_ID,
          type: 'multiple_choice',
          prompt: { en: 'Which year was Stonewall?', pt: 'Que ano?' },
          options: [
            { id: 'option-a', text: { en: '1969', pt: '1969' } },
            { id: 'option-b', text: { en: '1979', pt: '1979' } },
          ],
          shownOptions: [
            { id: 'option-b', text: { en: '1979', pt: '1979' } },
            { id: 'option-a', text: { en: '1969', pt: '1969' } },
          ],
          answer: { correctIndex: 0 },
          acceptedAnswers: [],
        },
        {
          id: SECOND_QUESTION_ID,
          type: 'true_false',
          prompt: { en: 'Never shown', pt: 'Nunca mostrada' },
          options: [],
          shownOptions: null,
          answer: { isTrue: true },
          acceptedAnswers: [],
        },
      ],
    },
    {
      kind: 'lie_detector',
      questions: [
        {
          id: THIRD_QUESTION_ID,
          type: 'prompt',
          prompt: { en: 'Name the flag', pt: 'Nomeia a bandeira' },
          options: [],
          shownOptions: null,
          answer: { truth: { en: 'Progress Pride', pt: 'Orgulho Progresso' } },
          acceptedAnswers: [],
        },
      ],
    },
  ],
};

const gameRow = (overrides: Record<string, unknown> = {}) => ({
  session_id: SESSION_ID,
  quiz_id: GAME_ID,
  owner_user_id: 'owner-1',
  event_id: null,
  // Played in reverse position order: the third question, then the first.
  question_log: [
    { questionId: THIRD_QUESTION_ID, openedAt: 2000, revealedAt: 2500 },
    { questionId: FIRST_QUESTION_ID, openedAt: 3000, revealedAt: null },
  ],
  quiz_snapshot: quizSnapshot,
  is_reporter_player: true,
  ...overrides,
});

const managerAnswering = (rows: unknown[]) => {
  const query = jest.fn().mockResolvedValue(rows);
  return { manager: { query } as unknown as EntityManager, query };
};

describe('captureQuizshowGameForReport', () => {
  it('captures only the questions the session showed, in play order, with no answer key', async () => {
    const { manager } = managerAnswering([gameRow()]);
    const evidence = await captureQuizshowGameForReport(
      manager,
      SESSION_ID,
      'reporter-1',
      CAPTURED_AT,
    );
    expect(evidence?.shownQuestions).toEqual([
      {
        roundKind: 'lie_detector',
        prompt: { en: 'Name the flag', pt: 'Nomeia a bandeira' },
        options: [],
      },
      {
        roundKind: 'quiz',
        prompt: { en: 'Which year was Stonewall?', pt: 'Que ano?' },
        options: [
          { en: '1979', pt: '1979' },
          { en: '1969', pt: '1969' },
        ],
      },
    ]);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('Never shown');
    expect(serialized).not.toContain('Progress Pride');
    for (const answerKey of [
      'correctIndex',
      'isTrue',
      'acceptedAnswers',
      'correctOrder',
      '"answer"',
    ]) {
      expect(serialized).not.toContain(answerKey);
    }
  });

  it('names the game, its title and its owner', async () => {
    const { manager, query } = managerAnswering([gameRow()]);
    const evidence = await captureQuizshowGameForReport(
      manager,
      SESSION_ID,
      'reporter-1',
      CAPTURED_AT,
    );
    expect(evidence).toEqual(
      expect.objectContaining({
        type: QUIZSHOW_GAME_SNAPSHOT_TYPE,
        sessionId: SESSION_ID,
        gameId: GAME_ID,
        quizTitle: 'Friday Pulse Live',
        ownerUserId: 'owner-1',
        capturedAt: CAPTURED_AT.toISOString(),
      }),
    );
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      SESSION_ID,
      'reporter-1',
    ]);
  });

  it('refuses a member with no player row in the session', async () => {
    const { manager, query } = managerAnswering([
      gameRow({ is_reporter_player: false }),
    ]);
    await expect(
      captureQuizshowGameForReport(
        manager,
        SESSION_ID,
        'stranger-1',
        CAPTURED_AT,
      ),
    ).resolves.toBeNull();
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('FROM "quizshow_players" "reporter"');
    expect(sql).toContain('"reporter"."user_id" = $2');
  });

  it('lets a removed player report', async () => {
    const { manager, query } = managerAnswering([gameRow()]);
    const evidence = await captureQuizshowGameForReport(
      manager,
      SESSION_ID,
      'removed-player-1',
      CAPTURED_AT,
    );
    expect(evidence).not.toBeNull();
    const sql = query.mock.calls[0][0] as string;
    expect(sql).not.toContain('removed_at');
  });

  it('refuses a quizshow_game report about an event session', async () => {
    const { manager, query } = managerAnswering([
      gameRow({ event_id: 'event-1', owner_user_id: null }),
    ]);
    await expect(
      captureQuizshowGameForReport(
        manager,
        SESSION_ID,
        'reporter-1',
        CAPTURED_AT,
      ),
    ).resolves.toBeNull();
    expect(query.mock.calls[0][0]).toContain(
      '"quiz"."owner_user_id" IS NOT NULL',
    );
  });
});

describe('ReportsService: the Pulse Live game subject', () => {
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
          createdAt: new Date('2026-10-20T21:00:00.000Z'),
          ...(row as object),
        }),
      ),
      manager: { query: jest.fn().mockResolvedValue([gameRow()]) },
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
      subjectType: ReportSubjectType.QuizshowGame,
      subjectId,
      reasonCode: 'hate_speech',
    });

  it('keeps the snapshot as evidence and lowercases the session id', async () => {
    await fileAgainst(SESSION_ID.toUpperCase());
    expect(reports.manager.query).toHaveBeenCalledWith(expect.any(String), [
      SESSION_ID,
      'reporter-1',
    ]);
    expect(reports.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ subjectId: SESSION_ID }),
      }),
    );
    const created = reports.create.mock.calls[0][0] as {
      subjectId: string;
      evidence: Array<Record<string, unknown>>;
    };
    expect(created.subjectId).toBe(SESSION_ID);
    expect(created.evidence).toHaveLength(1);
    expect(created.evidence[0]).toEqual(
      expect.objectContaining({
        type: QUIZSHOW_GAME_SNAPSHOT_TYPE,
        sessionId: SESSION_ID,
        gameId: GAME_ID,
        quizTitle: 'Friday Pulse Live',
        ownerUserId: 'owner-1',
      }),
    );
  });

  it('answers 404 Game not found to a malformed id or a refused capture', async () => {
    await expect(fileAgainst('not-a-uuid')).rejects.toThrow(
      new NotFoundException('Game not found'),
    );
    expect(reports.manager.query).not.toHaveBeenCalled();

    reports.manager.query.mockResolvedValue([
      gameRow({ is_reporter_player: false }),
    ]);
    await expect(fileAgainst(SESSION_ID, 'stranger-1')).rejects.toThrow(
      new NotFoundException('Game not found'),
    );
    reports.manager.query.mockResolvedValue([]);
    await expect(fileAgainst(SESSION_ID)).rejects.toThrow(
      new NotFoundException('Game not found'),
    );
    expect(reports.save).not.toHaveBeenCalled();
  });
});
