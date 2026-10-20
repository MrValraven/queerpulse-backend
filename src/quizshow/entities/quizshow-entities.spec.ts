import { getMetadataArgsStorage } from 'typeorm';
import { QuizshowAnswerRecord } from './quizshow-answer.entity';
import { QuizshowLobbyOpenRecord } from './quizshow-lobby-open.entity';
import { QuizshowPlayerRecord } from './quizshow-player.entity';
import { QuizshowQuestionRecord } from './quizshow-question.entity';
import { QuizshowQuizRecord } from './quizshow-quiz.entity';
import { QuizshowResultRecord } from './quizshow-result.entity';
import { QuizshowRoundRecord } from './quizshow-round.entity';
import { QuizshowSessionRecord } from './quizshow-session.entity';
import { QuizshowTeamRecord } from './quizshow-team.entity';
import { QuizshowVoteRecord } from './quizshow-vote.entity';

const ENTITY_CLASSES = [
  QuizshowQuizRecord,
  QuizshowRoundRecord,
  QuizshowQuestionRecord,
  QuizshowSessionRecord,
  QuizshowTeamRecord,
  QuizshowPlayerRecord,
  QuizshowAnswerRecord,
  QuizshowVoteRecord,
  QuizshowResultRecord,
  QuizshowLobbyOpenRecord,
];

const quizshowColumns = () =>
  getMetadataArgsStorage().columns.filter((column) =>
    ENTITY_CLASSES.includes(column.target as (typeof ENTITY_CLASSES)[number]),
  );

describe('quizshow entities', () => {
  it('maps ten tables', () => {
    const tableNames = getMetadataArgsStorage()
      .tables.filter((table) =>
        ENTITY_CLASSES.includes(
          table.target as (typeof ENTITY_CLASSES)[number],
        ),
      )
      .map((table) => table.name)
      .sort();
    expect(tableNames).toEqual(
      [
        'quizshow_answers',
        'quizshow_lobby_opens',
        'quizshow_players',
        'quizshow_questions',
        'quizshow_quizzes',
        'quizshow_results',
        'quizshow_rounds',
        'quizshow_sessions',
        'quizshow_teams',
        'quizshow_votes',
      ].sort(),
    );
  });

  it('keeps every timestamp at millisecond precision', () => {
    const timestampColumns = quizshowColumns().filter(
      (column) => column.options.type === 'timestamptz',
    );
    expect(timestampColumns.length).toBeGreaterThan(10);
    for (const column of timestampColumns) {
      expect(column.options.precision).toBe(3);
    }
  });

  it('never names a column explicitly', () => {
    const columns = quizshowColumns();
    expect(columns.length).toBeGreaterThan(50);
    for (const column of columns) {
      expect(column.options.name).toBeUndefined();
    }
  });

  it('declares the unique pairs the engine relies on', () => {
    const uniqueNames = getMetadataArgsStorage()
      .uniques.filter((unique) =>
        ENTITY_CLASSES.includes(
          unique.target as (typeof ENTITY_CLASSES)[number],
        ),
      )
      .map((unique) => unique.name);
    expect(uniqueNames).toEqual(
      expect.arrayContaining([
        'UQ_quizshow_players_session_user',
        'UQ_quizshow_answers_player_question',
        'UQ_quizshow_votes_voter_question',
        'UQ_quizshow_teams_session_color',
      ]),
    );
  });

  it('uses the named Postgres enum types', () => {
    const enumNames = quizshowColumns()
      .filter((column) => column.options.type === 'enum')
      .map((column) => column.options.enumName)
      .sort();
    expect(enumNames).toEqual(
      [
        'quizshow_content_label',
        'quizshow_language',
        'quizshow_language_mode',
        'quizshow_play_mode',
        'quizshow_question_type',
        'quizshow_round_kind',
        'quizshow_session_status',
        'quizshow_team_color_key',
      ].sort(),
    );
  });

  it('lets a quiz belong to an event or an owner', () => {
    const storage = getMetadataArgsStorage();
    const quizColumns = storage.columns.filter(
      (column) => column.target === QuizshowQuizRecord,
    );
    const columnOf = (propertyName: string) =>
      quizColumns.find((column) => column.propertyName === propertyName);
    expect(columnOf('eventId')?.options.nullable).toBe(true);
    expect(columnOf('ownerUserId')?.options.nullable).toBe(true);
    expect(columnOf('isAdultsOnly')?.options.type).toBe('boolean');
    expect(columnOf('isAdultsOnly')?.options.default).toBe(false);

    const checkNames = storage.checks
      .filter((check) => check.target === QuizshowQuizRecord)
      .map((check) => check.name);
    expect(checkNames).toContain('CHK_quizshow_quizzes_scope');

    const ownerRelation = storage.relations.find(
      (relation) =>
        relation.target === QuizshowQuizRecord &&
        relation.propertyName === 'owner',
    );
    expect(ownerRelation?.options.onDelete).toBe('CASCADE');
    expect(ownerRelation?.options.nullable).toBe(true);
    const ownerJoin = storage.joinColumns.find(
      (join) =>
        join.target === QuizshowQuizRecord && join.propertyName === 'owner',
    );
    expect(ownerJoin?.name).toBe('owner_user_id');
    expect(ownerJoin?.foreignKeyConstraintName).toBe(
      'FK_quizshow_quizzes_owner',
    );

    const ownerIndex = storage.indices.find(
      (index) => index.name === 'IDX_quizshow_quizzes_owner_user_id',
    );
    expect(ownerIndex?.target).toBe(QuizshowQuizRecord);
    expect(ownerIndex?.columns).toEqual(['ownerUserId']);
  });

  it('declares the per-quiz open session index and the opener index', () => {
    const storage = getMetadataArgsStorage();
    const sessionIndexOf = (name: string) =>
      storage.indices.find(
        (index) =>
          index.target === QuizshowSessionRecord && index.name === name,
      );
    const openQuizIndex = sessionIndexOf('UQ_quizshow_sessions_open_quiz');
    expect(openQuizIndex?.unique).toBe(true);
    expect(openQuizIndex?.columns).toEqual(['quizId']);
    expect(openQuizIndex?.where).toBe(
      `"status" IN ('lobby','running','paused')`,
    );
    const openerIndex = sessionIndexOf(
      'IDX_quizshow_sessions_started_by_started_at',
    );
    expect(openerIndex?.columns).toEqual(['startedByUserId', 'startedAt']);

    const sessionEventColumn = storage.columns.find(
      (column) =>
        column.target === QuizshowSessionRecord &&
        column.propertyName === 'eventId',
    );
    expect(sessionEventColumn?.options.nullable).toBe(true);
  });

  it('keys lobby opens to the member only, with the user and time index', () => {
    const storage = getMetadataArgsStorage();
    const relations = storage.relations.filter(
      (relation) => relation.target === QuizshowLobbyOpenRecord,
    );
    expect(relations.map((relation) => relation.propertyName)).toEqual([
      'user',
    ]);
    expect(relations[0]?.options.onDelete).toBe('CASCADE');
    const userJoin = storage.joinColumns.find(
      (join) =>
        join.target === QuizshowLobbyOpenRecord && join.propertyName === 'user',
    );
    expect(userJoin?.name).toBe('user_id');
    expect(userJoin?.foreignKeyConstraintName).toBe(
      'FK_quizshow_lobby_opens_user',
    );
    const openerIndex = storage.indices.find(
      (index) =>
        index.target === QuizshowLobbyOpenRecord &&
        index.name === 'IDX_quizshow_lobby_opens_user_opened',
    );
    expect(openerIndex?.columns).toEqual(['userId', 'openedAt']);
  });

  it('declares the plain quiz index on sessions', () => {
    const quizIndex = getMetadataArgsStorage().indices.find(
      (index) =>
        index.target === QuizshowSessionRecord &&
        index.name === 'IDX_quizshow_sessions_quiz_id',
    );
    expect(quizIndex?.columns).toEqual(['quizId']);
    expect(quizIndex?.unique).toBeFalsy();
  });
});
