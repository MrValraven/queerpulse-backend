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
import { QuizshowTemplateRecord } from './quizshow-template.entity';
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
  QuizshowTemplateRecord,
];

const quizshowColumns = () =>
  getMetadataArgsStorage().columns.filter((column) =>
    ENTITY_CLASSES.includes(column.target as (typeof ENTITY_CLASSES)[number]),
  );

describe('quizshow entities', () => {
  it('maps eleven tables', () => {
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
        'quizshow_templates',
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

  it('lets a quiz belong to an event, an owner or a template', () => {
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
    const scopeCheck = storage.checks.find(
      (check) =>
        check.target === QuizshowQuizRecord &&
        check.name === 'CHK_quizshow_quizzes_scope',
    );
    expect(scopeCheck?.expression).toBe(
      'num_nonnulls("event_id", "owner_user_id", "template_id") = 1',
    );

    expect(columnOf('templateId')?.options.nullable).toBe(true);
    const templateRelation = storage.relations.find(
      (relation) =>
        relation.target === QuizshowQuizRecord &&
        relation.propertyName === 'template',
    );
    expect(templateRelation?.options.onDelete).toBe('CASCADE');
    expect(templateRelation?.options.nullable).toBe(true);
    const templateJoin = storage.joinColumns.find(
      (join) =>
        join.target === QuizshowQuizRecord && join.propertyName === 'template',
    );
    expect(templateJoin?.name).toBe('template_id');
    expect(templateJoin?.foreignKeyConstraintName).toBe(
      'FK_quizshow_quizzes_template',
    );
    const templateUnique = storage.uniques.find(
      (unique) =>
        unique.target === QuizshowQuizRecord &&
        unique.name === 'UQ_quizshow_quizzes_template_id',
    );
    expect(templateUnique?.columns).toEqual(['templateId']);

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

  it('keeps the source template and lets it go null', () => {
    const storage = getMetadataArgsStorage();
    const sourceColumn = storage.columns.find(
      (column) =>
        column.target === QuizshowQuizRecord &&
        column.propertyName === 'sourceTemplateId',
    );
    expect(sourceColumn?.options.nullable).toBe(true);
    const sourceRelation = storage.relations.find(
      (relation) =>
        relation.target === QuizshowQuizRecord &&
        relation.propertyName === 'sourceTemplate',
    );
    expect(sourceRelation?.options.onDelete).toBe('SET NULL');
    expect(sourceRelation?.options.nullable).toBe(true);
    const sourceJoin = storage.joinColumns.find(
      (join) =>
        join.target === QuizshowQuizRecord &&
        join.propertyName === 'sourceTemplate',
    );
    expect(sourceJoin?.name).toBe('source_template_id');
    expect(sourceJoin?.foreignKeyConstraintName).toBe(
      'FK_quizshow_quizzes_source_template',
    );
    const sourceIndex = storage.indices.find(
      (index) => index.name === 'IDX_quizshow_quizzes_source_template_id',
    );
    expect(sourceIndex?.target).toBe(QuizshowQuizRecord);
    expect(sourceIndex?.columns).toEqual(['sourceTemplateId']);
  });

  it('drops the starter pack key', () => {
    const starterPackColumn = getMetadataArgsStorage().columns.find(
      (column) =>
        column.target === QuizshowQuizRecord &&
        column.propertyName === 'starterPackKey',
    );
    expect(starterPackColumn).toBeUndefined();
  });

  it('keeps a template publisher that goes null with the account', () => {
    const storage = getMetadataArgsStorage();
    const templateColumns = storage.columns.filter(
      (column) => column.target === QuizshowTemplateRecord,
    );
    const columnOf = (propertyName: string) =>
      templateColumns.find((column) => column.propertyName === propertyName);
    expect(columnOf('publishedByUserId')?.options.nullable).toBe(true);
    expect(columnOf('publishedAt')?.options.nullable).toBe(true);
    const publisherRelation = storage.relations.find(
      (relation) =>
        relation.target === QuizshowTemplateRecord &&
        relation.propertyName === 'publishedBy',
    );
    expect(publisherRelation?.options.onDelete).toBe('SET NULL');
    expect(publisherRelation?.options.nullable).toBe(true);
    const publisherJoin = storage.joinColumns.find(
      (join) =>
        join.target === QuizshowTemplateRecord &&
        join.propertyName === 'publishedBy',
    );
    expect(publisherJoin?.name).toBe('published_by_user_id');
    expect(publisherJoin?.foreignKeyConstraintName).toBe(
      'FK_quizshow_templates_published_by',
    );
    expect(columnOf('staffNotes')?.options.length).toBe(20000);
    expect(columnOf('staffNotes')?.options.default).toBe('');
    expect(columnOf('cardTitleEn')?.options.length).toBe(120);
    expect(columnOf('cardTitlePt')?.options.length).toBe(120);
    expect(columnOf('cardDescriptionEn')?.options.length).toBe(300);
    expect(columnOf('cardDescriptionPt')?.options.length).toBe(300);
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
