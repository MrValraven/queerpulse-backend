import { getMetadataArgsStorage } from 'typeorm';
import { QuizshowAnswerRecord } from './quizshow-answer.entity';
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
];

const quizshowColumns = () =>
  getMetadataArgsStorage().columns.filter((column) =>
    ENTITY_CLASSES.includes(column.target as (typeof ENTITY_CLASSES)[number]),
  );

describe('quizshow entities', () => {
  it('maps nine tables', () => {
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
});
