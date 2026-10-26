import { AdvancedConsoleLogger, type LogLevel, type LogMessage } from 'typeorm';
import {
  PRIVATE_PARAMETER_TABLES,
  PRIVATE_PARAMETERS_COMMENT,
  PrivateParametersLogger,
  touchesPrivateParameterTable,
} from './private-parameters-logger';

/** Records what the logger would write, so a spec reads the message objects. */
class CapturingLogger extends PrivateParametersLogger {
  readonly written: { level: LogLevel; messages: LogMessage[] }[] = [];

  protected writeLog(
    level: LogLevel,
    logMessage: LogMessage | LogMessage[],
  ): void {
    this.written.push({
      level,
      messages: Array.isArray(logMessage) ? logMessage : [logMessage],
    });
  }
}

const DRAFT_PAYLOAD = { title: 'Picnic in the park' };
const DRAFT_SQL =
  'UPDATE "creator_drafts" SET "payload" = $4 WHERE "user_id" = $1';

function sqlMessage(logger: CapturingLogger): LogMessage | undefined {
  return logger.written[0]?.messages.find(
    (message) => message.format === 'sql',
  );
}

describe('touchesPrivateParameterTable', () => {
  it.each(PRIVATE_PARAMETER_TABLES.filter((table) => table.includes('_')))(
    'matches %s quoted or bare',
    (table) => {
      expect(touchesPrivateParameterTable(`SELECT * FROM "${table}"`)).toBe(
        true,
      );
      expect(
        touchesPrivateParameterTable(`delete from ${table} where 1=1`),
      ).toBe(true);
    },
  );

  it('matches the member drafts table as the quoted identifier TypeORM writes', () => {
    expect(
      touchesPrivateParameterTable(
        'UPDATE "draft" SET "payload" = $1 WHERE "id" = $2',
      ),
    ).toBe(true);
    expect(
      touchesPrivateParameterTable(
        'SELECT "Draft"."id" FROM "Draft" "Draft" WHERE "Draft"."user_id" = $1',
      ),
    ).toBe(true);
  });

  it('leaves a draft status value and other tables naming drafts alone', () => {
    expect(
      touchesPrivateParameterTable(
        `SELECT * FROM "studio_releases" WHERE "status" = 'draft'`,
      ),
    ).toBe(false);
    expect(
      touchesPrivateParameterTable('SELECT * FROM "draft_templates"'),
    ).toBe(false);
    expect(touchesPrivateParameterTable('SELECT * FROM "event_drafts"')).toBe(
      false,
    );
  });

  it('matches a joined private table and any letter case', () => {
    expect(
      touchesPrivateParameterTable(
        'SELECT 1 FROM "users" JOIN "Listing_Drafts" ON true',
      ),
    ).toBe(true);
  });

  it('leaves other tables and longer names alone', () => {
    expect(touchesPrivateParameterTable('SELECT * FROM "users"')).toBe(false);
    expect(
      touchesPrivateParameterTable('SELECT * FROM "creator_drafts_archive"'),
    ).toBe(false);
    expect(
      touchesPrivateParameterTable('SELECT * FROM "my_quizshow_teams"'),
    ).toBe(false);
  });

  it('leaves out the parameters of queries on the quiz, round, question and session tables', () => {
    expect(
      touchesPrivateParameterTable(
        'SELECT * FROM "quizshow_quizzes" WHERE "title" = $1',
      ),
    ).toBe(true);
    expect(
      touchesPrivateParameterTable('UPDATE quizshow_rounds SET "title" = $1'),
    ).toBe(true);
    expect(
      touchesPrivateParameterTable(
        'INSERT INTO "quizshow_questions" ("prompt") VALUES ($1)',
      ),
    ).toBe(true);
    expect(
      touchesPrivateParameterTable(
        'SELECT * FROM "quizshow_sessions" WHERE "id" = $1',
      ),
    ).toBe(true);
  });

  it('matches any table when the query carries the private-parameters comment', () => {
    expect(
      touchesPrivateParameterTable(
        '/* private-parameters */ SELECT "user"."id" FROM "users" "user" WHERE lower("user"."email") = lower($1)',
      ),
    ).toBe(true);
    expect(
      touchesPrivateParameterTable(
        'SELECT "user"."id" FROM "users" "user" WHERE lower("user"."email") = lower($1)',
      ),
    ).toBe(false);
  });

  it('names the draft, quiz show and sign-in code challenge tables', () => {
    expect([...PRIVATE_PARAMETER_TABLES]).toEqual([
      'creator_drafts',
      'listing_drafts',
      'draft',
      'quizshow_answers',
      'quizshow_votes',
      'quizshow_players',
      'quizshow_teams',
      'quizshow_quizzes',
      'quizshow_rounds',
      'quizshow_questions',
      'quizshow_sessions',
      'email_sign_in_challenges',
    ]);
  });
});

describe('PrivateParametersLogger', () => {
  it('extends the default TypeORM logger', () => {
    expect(new PrivateParametersLogger(['error', 'warn'])).toBeInstanceOf(
      AdvancedConsoleLogger,
    );
  });

  it('drops the parameters of a failed query on a private table and keeps the SQL and the error', () => {
    const logger = new CapturingLogger(['error', 'warn']);
    logger.logQueryError('connection reset', DRAFT_SQL, [
      'member-1',
      'event',
      '',
      DRAFT_PAYLOAD,
    ]);
    const messages = logger.written[0]?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(sqlMessage(logger)?.message).toContain('"creator_drafts"');
    expect(sqlMessage(logger)?.parameters).toBeUndefined();
    expect(JSON.stringify(messages)).not.toContain('Picnic');
    expect(messages[1]?.message).toBe('connection reset');
  });

  it('drops the parameters of a slow query on a private table and keeps the time', () => {
    const logger = new CapturingLogger(['error', 'warn']);
    logger.logQuerySlow(
      900,
      'SELECT * FROM "quizshow_answers" WHERE "id" = $1',
      ['Freddie Mercury'],
    );
    const messages = logger.written[0]?.messages ?? [];
    expect(JSON.stringify(messages)).not.toContain('Freddie');
    expect(messages[1]?.message).toBe(900);
  });

  it('keeps the parameters of a failed or slow query on any other table', () => {
    const logger = new CapturingLogger(['error', 'warn']);
    logger.logQueryError('boom', 'SELECT * FROM "users" WHERE "id" = $1', [
      'member-1',
    ]);
    logger.logQuerySlow(900, 'SELECT * FROM "events" WHERE "id" = $1', [
      'event-1',
    ]);
    expect(JSON.stringify(logger.written[0]?.messages)).toContain('member-1');
    expect(JSON.stringify(logger.written[1]?.messages)).toContain('event-1');
  });

  it('drops the parameters of a failed or slow query tagged with the private-parameters comment', () => {
    const logger = new CapturingLogger(['error', 'warn']);
    const taggedSql = `/* ${PRIVATE_PARAMETERS_COMMENT} */ SELECT "jr"."id" FROM "join_requests" "jr" WHERE lower("jr"."email") = $1`;
    logger.logQueryError('boom', taggedSql, ['sam@example.com']);
    logger.logQuerySlow(900, taggedSql, ['sam@example.com']);
    expect(sqlMessage(logger)?.message).toContain('/* private-parameters */');
    expect(sqlMessage(logger)?.parameters).toBeUndefined();
    expect(JSON.stringify(logger.written)).not.toContain('sam@example.com');
  });

  it('keeps the parameters of the same query without the comment', () => {
    const logger = new CapturingLogger(['error', 'warn']);
    logger.logQueryError(
      'boom',
      'SELECT "jr"."id" FROM "join_requests" "jr" WHERE "jr"."id" = $1',
      ['request-1'],
    );
    expect(sqlMessage(logger)?.parameters).toEqual(['request-1']);
  });

  it('still honours the logging levels it was given', () => {
    const logger = new CapturingLogger(['warn']);
    logger.logQueryError('boom', DRAFT_SQL, ['member-1']);
    expect(logger.written).toHaveLength(0);
  });

  it('drops the parameters of a logged query on a private table too', () => {
    const logger = new CapturingLogger('all');
    logger.logQuery(DRAFT_SQL, ['member-1', 'event', '', DRAFT_PAYLOAD]);
    expect(JSON.stringify(logger.written[0]?.messages)).not.toContain('Picnic');
  });
});
