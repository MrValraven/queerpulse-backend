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

  it('leaves out the parameters of queries on the templates table', () => {
    expect(
      touchesPrivateParameterTable(
        'UPDATE "quizshow_templates" SET "staff_notes" = $1',
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

  it('names the draft, quiz show, sign-in code challenge, leads and VJ tables', () => {
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
      'quizshow_templates',
      'leads',
      'lead_entries',
      'vj_clips',
      'vj_packs',
      'vj_scenes',
      'vj_setlists',
    ]);
  });

  it('matches the VJ tables quoted or bare', () => {
    expect(
      touchesPrivateParameterTable(
        'SELECT "clip"."title" FROM "vj_clips" "clip"',
      ),
    ).toBe(true);
    expect(touchesPrivateParameterTable('UPDATE vj_packs SET name = $1')).toBe(
      true,
    );
    expect(touchesPrivateParameterTable('SELECT * FROM "vj_pack_clips"')).toBe(
      false,
    );
  });

  it('matches the set list table quoted or bare and leaves vj_setlist_items alone', () => {
    expect(
      touchesPrivateParameterTable(
        'SELECT "setlist"."name" FROM "vj_setlists" "setlist"',
      ),
    ).toBe(true);
    expect(
      touchesPrivateParameterTable('UPDATE vj_setlists SET name = $1'),
    ).toBe(true);
    expect(
      touchesPrivateParameterTable(
        'INSERT INTO "vj_setlist_items" ("setlist_id", "scene_id") VALUES ($1, $2)',
      ),
    ).toBe(false);
    expect(
      touchesPrivateParameterTable('SELECT "vj_scenes"."look" FROM vj_scenes'),
    ).toBe(true);
  });

  it('matches the leads table as the quoted identifier TypeORM writes', () => {
    expect(
      touchesPrivateParameterTable('SELECT "lead"."id" FROM "leads" "lead"'),
    ).toBe(true);
    expect(touchesPrivateParameterTable('SELECT * FROM "LEADS"')).toBe(true);
    expect(touchesPrivateParameterTable(`SELECT 'leads'`)).toBe(false);
    expect(touchesPrivateParameterTable('SELECT * FROM "leads_archive"')).toBe(
      false,
    );
  });

  it('matches the lead entries table quoted or bare', () => {
    expect(
      touchesPrivateParameterTable(
        'INSERT INTO "lead_entries" ("body") VALUES ($1)',
      ),
    ).toBe(true);
    expect(
      touchesPrivateParameterTable('select * from lead_entries where 1=1'),
    ).toBe(true);
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

  it('drops the parameters of a slow query on the leads table and keeps the time', () => {
    const logger = new CapturingLogger(['error', 'warn']);
    logger.logQuerySlow(
      900,
      'SELECT "lead"."id" FROM "leads" "lead" WHERE "lead"."email" = $1',
      ['ana@example.org'],
    );
    const messages = logger.written[0]?.messages ?? [];
    expect(sqlMessage(logger)?.parameters).toBeUndefined();
    expect(JSON.stringify(messages)).not.toContain('ana@example.org');
    expect(messages[1]?.message).toBe(900);
  });

  it('drops the parameters of a slow query on vj_clips and keeps the time', () => {
    const logger = new CapturingLogger(['error', 'warn']);
    logger.logQuerySlow(
      900,
      'SELECT "clip"."id" FROM "vj_clips" "clip" WHERE "clip"."title" = $1',
      ['Secret title'],
    );
    const messages = logger.written[0]?.messages ?? [];
    expect(sqlMessage(logger)?.parameters).toBeUndefined();
    expect(JSON.stringify(messages)).not.toContain('Secret title');
    expect(messages[1]?.message).toBe(900);
  });

  it('drops the parameters of a slow query on vj_scenes', () => {
    const logger = new CapturingLogger(['error', 'warn']);
    logger.logQuerySlow(
      900,
      'UPDATE "vj_scenes" SET "name" = $1, "look" = $2 WHERE "id" = $3',
      ['Secret scene', { overlayText: 'Secret overlay' }, 'scene-1'],
    );
    const messages = logger.written[0]?.messages ?? [];
    expect(sqlMessage(logger)?.parameters).toBeUndefined();
    expect(sqlMessage(logger)?.message).toContain('"vj_scenes"');
    expect(JSON.stringify(messages)).not.toContain('Secret scene');
    expect(JSON.stringify(messages)).not.toContain('Secret overlay');
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
