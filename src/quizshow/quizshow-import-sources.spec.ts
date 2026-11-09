import {
  GAME_IMPORT_SOURCES_SQL,
  IMPORT_SOURCES_SQL,
} from './quizshow-import-sources';

describe('quizshow import sources SQL', () => {
  it.each([
    ['IMPORT_SOURCES_SQL', IMPORT_SOURCES_SQL],
    ['GAME_IMPORT_SOURCES_SQL', GAME_IMPORT_SOURCES_SQL],
  ])(
    '%s counts rounds without wheel steps, with a cast that runs before the enum has the label',
    (_name, sql) => {
      const roundCountSubquery = sql.slice(0, sql.indexOf('AS "round_count"'));
      expect(roundCountSubquery).toContain(
        `AND "round"."kind"::text <> 'wheel'`,
      );
      expect(sql.match(/<> 'wheel'/g)).toHaveLength(1);
    },
  );
});
