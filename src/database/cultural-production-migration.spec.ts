// Lives beside the migration runner in `src/database`, outside
// `src/migrations`: the TypeORM CLI and `DatabaseModule` both require every
// `src/migrations/*.ts` file in development, and requiring a spec there throws
// `describe is not defined` before any migration runs.
//
// The spec runs the migration class against a recording query runner and
// compares each statement with the contract text, whitespace collapsed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QueryRunner } from 'typeorm';
import { AddCulturalProduction1840600000000 } from '../migrations/1840600000000-AddCulturalProduction';
import { CULTURAL_PRODUCTION_GUIDE_SEEDS_1840600000000 } from '../migrations/data/cultural-production-guides-1840600000000.seed';

const MIGRATION_PATH = join(
  __dirname,
  '..',
  'migrations',
  '1840600000000-AddCulturalProduction.ts',
);

/** The schema statements of contract section 3 `up()`, in order, before the seed. */
const CONTRACT_SCHEMA_STATEMENTS = [
  `CREATE TABLE "cultural_ideas" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "title" character varying(160) NOT NULL,
    "description" text NOT NULL DEFAULT '',
    "event_type" character varying(32) NOT NULL,
    "status" character varying(16) NOT NULL DEFAULT 'new',
    "author_id" uuid,
    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT "PK_cultural_ideas" PRIMARY KEY ("id"),
    CONSTRAINT "CHK_cultural_ideas_title" CHECK (char_length(btrim("title")) >= 1),
    CONSTRAINT "CHK_cultural_ideas_description" CHECK (char_length("description") <= 4000),
    CONSTRAINT "CHK_cultural_ideas_event_type" CHECK ("event_type" IN ('board_game_night', 'quiz_night', 'music_night', 'film_night', 'workshop', 'talk', 'party', 'other')),
    CONSTRAINT "CHK_cultural_ideas_status" CHECK ("status" IN ('new', 'exploring', 'planned', 'parked')),
    CONSTRAINT "FK_cultural_ideas_author" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
  )`,
  `CREATE INDEX "IDX_cultural_ideas_created_at" ON "cultural_ideas" ("created_at" DESC, "id" DESC)`,
  `CREATE INDEX "IDX_cultural_ideas_author_id" ON "cultural_ideas" ("author_id") WHERE "author_id" IS NOT NULL`,
  `CREATE TABLE "cultural_idea_backers" (
    "idea_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT "PK_cultural_idea_backers" PRIMARY KEY ("idea_id", "user_id"),
    CONSTRAINT "FK_cultural_idea_backers_idea" FOREIGN KEY ("idea_id") REFERENCES "cultural_ideas"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "FK_cultural_idea_backers_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
  )`,
  `CREATE INDEX "IDX_cultural_idea_backers_user_id" ON "cultural_idea_backers" ("user_id")`,
  `CREATE TABLE "cultural_idea_comments" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "idea_id" uuid NOT NULL,
    "author_id" uuid,
    "body" text NOT NULL,
    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT "PK_cultural_idea_comments" PRIMARY KEY ("id"),
    CONSTRAINT "CHK_cultural_idea_comments_body" CHECK (char_length(btrim("body")) >= 1 AND char_length("body") <= 2000),
    CONSTRAINT "FK_cultural_idea_comments_idea" FOREIGN KEY ("idea_id") REFERENCES "cultural_ideas"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "FK_cultural_idea_comments_author" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
  )`,
  `CREATE INDEX "IDX_cultural_idea_comments_idea_created_at" ON "cultural_idea_comments" ("idea_id", "created_at", "id")`,
  `CREATE INDEX "IDX_cultural_idea_comments_author_id" ON "cultural_idea_comments" ("author_id") WHERE "author_id" IS NOT NULL`,
  `CREATE TABLE "cultural_guides" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "title" character varying(160) NOT NULL,
    "event_type" character varying(32) NOT NULL,
    "locale" character varying(2) NOT NULL,
    "summary" character varying(500) NOT NULL DEFAULT '',
    "sections" jsonb NOT NULL DEFAULT '[]',
    "revision" integer NOT NULL DEFAULT 1,
    "author_id" uuid,
    "updated_by_id" uuid,
    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT "PK_cultural_guides" PRIMARY KEY ("id"),
    CONSTRAINT "CHK_cultural_guides_title" CHECK (char_length(btrim("title")) >= 1),
    CONSTRAINT "CHK_cultural_guides_event_type" CHECK ("event_type" IN ('board_game_night', 'quiz_night', 'music_night', 'film_night', 'workshop', 'talk', 'party', 'other')),
    CONSTRAINT "CHK_cultural_guides_locale" CHECK ("locale" IN ('en', 'pt')),
    CONSTRAINT "CHK_cultural_guides_sections" CHECK (CASE WHEN jsonb_typeof("sections") = 'array' THEN jsonb_array_length("sections") <= 30 ELSE false END),
    CONSTRAINT "CHK_cultural_guides_revision" CHECK ("revision" >= 1),
    CONSTRAINT "FK_cultural_guides_author" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "FK_cultural_guides_updated_by" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
  )`,
  `CREATE INDEX "IDX_cultural_guides_event_type_locale" ON "cultural_guides" ("event_type", "locale")`,
  `CREATE INDEX "IDX_cultural_guides_author_id" ON "cultural_guides" ("author_id") WHERE "author_id" IS NOT NULL`,
  `CREATE INDEX "IDX_cultural_guides_updated_by_id" ON "cultural_guides" ("updated_by_id") WHERE "updated_by_id" IS NOT NULL`,
  `CREATE TABLE "cultural_tasks" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "title" character varying(160) NOT NULL,
    "notes" text NOT NULL DEFAULT '',
    "status" character varying(16) NOT NULL DEFAULT 'todo',
    "due_on" date,
    "event_on" date,
    "idea_id" uuid,
    "guide_id" uuid,
    "author_id" uuid,
    "completed_at" TIMESTAMP WITH TIME ZONE,
    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT "PK_cultural_tasks" PRIMARY KEY ("id"),
    CONSTRAINT "CHK_cultural_tasks_title" CHECK (char_length(btrim("title")) >= 1),
    CONSTRAINT "CHK_cultural_tasks_notes" CHECK (char_length("notes") <= 4000),
    CONSTRAINT "CHK_cultural_tasks_status" CHECK ("status" IN ('todo', 'doing', 'done')),
    CONSTRAINT "CHK_cultural_tasks_completed" CHECK (("status" = 'done') = ("completed_at" IS NOT NULL)),
    CONSTRAINT "FK_cultural_tasks_idea" FOREIGN KEY ("idea_id") REFERENCES "cultural_ideas"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "FK_cultural_tasks_guide" FOREIGN KEY ("guide_id") REFERENCES "cultural_guides"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "FK_cultural_tasks_author" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
  )`,
  `CREATE INDEX "IDX_cultural_tasks_status_due_on" ON "cultural_tasks" ("status", "due_on")`,
  `CREATE INDEX "IDX_cultural_tasks_idea_id" ON "cultural_tasks" ("idea_id") WHERE "idea_id" IS NOT NULL`,
  `CREATE INDEX "IDX_cultural_tasks_guide_id" ON "cultural_tasks" ("guide_id") WHERE "guide_id" IS NOT NULL`,
  `CREATE INDEX "IDX_cultural_tasks_author_id" ON "cultural_tasks" ("author_id") WHERE "author_id" IS NOT NULL`,
  `CREATE TABLE "cultural_task_assignees" (
    "task_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "assigned_by_id" uuid,
    "assigned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT "PK_cultural_task_assignees" PRIMARY KEY ("task_id", "user_id"),
    CONSTRAINT "FK_cultural_task_assignees_task" FOREIGN KEY ("task_id") REFERENCES "cultural_tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "FK_cultural_task_assignees_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "FK_cultural_task_assignees_assigned_by" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
  )`,
  `CREATE INDEX "IDX_cultural_task_assignees_user_id" ON "cultural_task_assignees" ("user_id")`,
  `CREATE INDEX "IDX_cultural_task_assignees_assigned_by_id" ON "cultural_task_assignees" ("assigned_by_id") WHERE "assigned_by_id" IS NOT NULL`,
];

/** The seed insert of contract section 3, run once per seeded guide. */
const CONTRACT_SEED_INSERT = `INSERT INTO "cultural_guides" ("id", "title", "event_type", "locale", "summary", "sections", "revision", "author_id", "updated_by_id")
VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, NULL, NULL)`;

/** The two label appends of contract section 3, the last statements of `up()`. */
const CONTRACT_ENUM_STATEMENTS = [
  `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'cultural_task_assigned'`,
  `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'cultural_task_batch_assigned'`,
];

/** The statements of contract section 3 `down()`, in order. */
const CONTRACT_DOWN_STATEMENTS = [
  `DELETE FROM "notifications" WHERE "type" IN ('cultural_task_assigned', 'cultural_task_batch_assigned')`,
  `DROP TABLE "cultural_task_assignees"`,
  `DROP TABLE "cultural_tasks"`,
  `DROP TABLE "cultural_idea_comments"`,
  `DROP TABLE "cultural_idea_backers"`,
  `DROP TABLE "cultural_ideas"`,
  `DROP TABLE "cultural_guides"`,
];

/** The six tables the migration creates. */
const CULTURAL_TABLES = [
  'cultural_ideas',
  'cultural_idea_backers',
  'cultural_idea_comments',
  'cultural_guides',
  'cultural_tasks',
  'cultural_task_assignees',
];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One recorded `query` call: the collapsed SQL and its parameters. */
interface RecordedStatement {
  sql: string;
  parameters: unknown[] | undefined;
}

/** The section shape the seed insert stores in `sections`. */
interface StoredSection {
  id: string;
  heading: string;
  body: string;
  steps: Array<{ id: string; text: string; daysBefore: number | null }>;
}

/** `sql` with whitespace runs folded and the space inside parentheses dropped. */
function collapsed(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim();
}

/** Every `query` call one direction makes, in order. */
async function statementsOf(
  direction: 'up' | 'down',
): Promise<RecordedStatement[]> {
  const query = jest.fn().mockResolvedValue(undefined);
  await new AddCulturalProduction1840600000000()[direction]({
    query,
  } as unknown as QueryRunner);
  return query.mock.calls.map(
    ([sql, parameters]: [string, unknown[] | undefined]) => ({
      sql: collapsed(sql),
      parameters,
    }),
  );
}

/** The recorded seed inserts of one `up()` run. */
async function seedInserts(): Promise<RecordedStatement[]> {
  const statements = await statementsOf('up');
  return statements.filter((statement) =>
    statement.sql.startsWith('INSERT INTO "cultural_guides"'),
  );
}

/** The `sections` a seed insert stores, parsed from its sixth parameter. */
function storedSectionsOf(statement: RecordedStatement): StoredSection[] {
  return JSON.parse(String(statement.parameters?.[5])) as StoredSection[];
}

describe('AddCulturalProduction1840600000000', () => {
  it('opens with the do not run line', () => {
    expect(readFileSync(MIGRATION_PATH, 'utf8').split('\n')[0]).toBe(
      '// DO NOT RUN: authored for review only; the maintainer runs migrations.',
    );
  });

  it('keeps the default transaction', () => {
    const migration = new AddCulturalProduction1840600000000();
    expect(migration.name).toBe('AddCulturalProduction1840600000000');
    expect(
      (migration as { transaction?: unknown }).transaction,
    ).toBeUndefined();
  });

  it('creates the six tables before seeding and adds the enum labels last', async () => {
    const statements = (await statementsOf('up')).map(
      (statement) => statement.sql,
    );
    const schemaCount = CONTRACT_SCHEMA_STATEMENTS.length;
    const seedCount = CULTURAL_PRODUCTION_GUIDE_SEEDS_1840600000000.length;

    expect(statements).toHaveLength(
      schemaCount + seedCount + CONTRACT_ENUM_STATEMENTS.length,
    );
    expect(statements.slice(0, schemaCount)).toEqual(
      CONTRACT_SCHEMA_STATEMENTS.map(collapsed),
    );
    expect(statements.slice(schemaCount, schemaCount + seedCount)).toEqual(
      Array.from({ length: seedCount }, () => collapsed(CONTRACT_SEED_INSERT)),
    );
    expect(statements.slice(schemaCount + seedCount)).toEqual(
      CONTRACT_ENUM_STATEMENTS.map(collapsed),
    );

    const firstInsertIndex = statements.findIndex((sql) =>
      sql.startsWith('INSERT INTO'),
    );
    for (const table of CULTURAL_TABLES) {
      const createIndex = statements.findIndex((sql) =>
        sql.startsWith(`CREATE TABLE "${table}" (`),
      );
      expect(createIndex).toBeGreaterThanOrEqual(0);
      expect(createIndex).toBeLessThan(firstInsertIndex);
    }
  });

  it('seeds four guides with fresh section and step ids', async () => {
    const inserts = await seedInserts();
    expect(inserts).toHaveLength(4);

    expect(inserts.map((insert) => insert.parameters?.slice(0, 5))).toEqual(
      CULTURAL_PRODUCTION_GUIDE_SEEDS_1840600000000.map((seed) => [
        seed.id,
        seed.title,
        seed.eventType,
        seed.locale,
        seed.summary,
      ]),
    );

    const storedWithoutIds = inserts.map((insert) =>
      storedSectionsOf(insert).map((section) => ({
        heading: section.heading,
        body: section.body,
        steps: section.steps.map((step) => ({
          text: step.text,
          daysBefore: step.daysBefore,
        })),
      })),
    );
    expect(storedWithoutIds).toEqual(
      CULTURAL_PRODUCTION_GUIDE_SEEDS_1840600000000.map(
        (seed) => seed.sections,
      ),
    );

    const seenIds = new Set<string>();
    for (const section of inserts.flatMap(storedSectionsOf)) {
      expect(section.id).toMatch(UUID_PATTERN);
      seenIds.add(section.id);
      for (const step of section.steps) {
        expect(step.id).toMatch(UUID_PATTERN);
        seenIds.add(step.id);
      }
    }

    const storedIdCount = inserts
      .flatMap(storedSectionsOf)
      .reduce((count, section) => count + 1 + section.steps.length, 0);
    expect(seenIds.size).toBe(storedIdCount);

    const secondRunIds = (await seedInserts())
      .flatMap(storedSectionsOf)
      .map((section) => section.id);
    for (const sectionId of secondRunIds) {
      expect(seenIds.has(sectionId)).toBe(false);
    }
  });

  it('seeds 20 board game steps and 18 quiz steps per language', async () => {
    const inserts = await seedInserts();
    const stepCounts = inserts.map((insert) => ({
      eventType: insert.parameters?.[2],
      locale: insert.parameters?.[3],
      sectionCount: storedSectionsOf(insert).length,
      stepCount: storedSectionsOf(insert).reduce(
        (count, section) => count + section.steps.length,
        0,
      ),
    }));
    expect(stepCounts).toEqual([
      {
        eventType: 'board_game_night',
        locale: 'en',
        sectionCount: 7,
        stepCount: 20,
      },
      {
        eventType: 'board_game_night',
        locale: 'pt',
        sectionCount: 7,
        stepCount: 20,
      },
      { eventType: 'quiz_night', locale: 'en', sectionCount: 7, stepCount: 18 },
      { eventType: 'quiz_night', locale: 'pt', sectionCount: 7, stepCount: 18 },
    ]);

    const daysByGuide = inserts.map((insert) =>
      storedSectionsOf(insert).map((section) =>
        section.steps.map((step) => step.daysBefore),
      ),
    );
    const [boardEnglish, boardPortuguese, quizEnglish, quizPortuguese] =
      daysByGuide;
    expect(boardPortuguese).toEqual(boardEnglish);
    expect(quizPortuguese).toEqual(quizEnglish);
  });

  it('drops the tasks table before the ideas and guides it references', async () => {
    const statements = (await statementsOf('down')).map(
      (statement) => statement.sql,
    );
    expect(statements).toEqual(CONTRACT_DOWN_STATEMENTS.map(collapsed));

    const tasksDropIndex = statements.indexOf('DROP TABLE "cultural_tasks"');
    expect(tasksDropIndex).toBeLessThan(
      statements.indexOf('DROP TABLE "cultural_ideas"'),
    );
    expect(tasksDropIndex).toBeLessThan(
      statements.indexOf('DROP TABLE "cultural_guides"'),
    );
    expect(statements.join(' ')).not.toContain('notifications_type_enum');
  });
});
