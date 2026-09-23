// Lives beside the migration runner in `src/database`, outside
// `src/migrations`: the TypeORM CLI and `DatabaseModule` both require every
// `src/migrations/*.ts` file in development, and requiring a spec there
// throws `describe is not defined` before any migration runs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    __dirname,
    '..',
    'migrations',
    '1821220000000-AddMessagingIdentityColumns.ts',
  ),
  'utf8',
);

const upBody = sql.slice(
  sql.indexOf('public async up('),
  sql.indexOf('public async down('),
);
const downBody = sql.slice(sql.indexOf('public async down('));

describe('the messaging identity columns migration backfills identities correctly', () => {
  it('adds both columns as nullable before either backfill runs', () => {
    const addColumnsBlock = upBody.slice(
      0,
      upBody.indexOf('UPDATE "conversation_participants"'),
    );

    expect(addColumnsBlock).toContain(
      'ALTER TABLE "conversation_participants" ADD COLUMN "identity_id" uuid',
    );
    expect(addColumnsBlock).toContain(
      'ALTER TABLE "messages" ADD COLUMN "sender_identity_id" uuid',
    );
    expect(addColumnsBlock).not.toMatch(/NOT NULL/);
  });

  it("backfills each seat's identity from the identity owned by the seat's own user", () => {
    const statement = upBody.slice(
      upBody.indexOf('UPDATE "conversation_participants" AS "participant"'),
      upBody.indexOf('UPDATE "messages" AS "message"'),
    );

    expect(statement).toContain('SET "identity_id" = "identity"."id"');
    expect(statement).toContain('FROM "identities" AS "identity"');
    expect(statement).toContain(
      '"identity"."user_id" = "participant"."user_id"',
    );
    expect(statement).toContain(`"identity"."kind" = 'profile'`);
  });

  it("backfills each message's sender identity from the identity owned by the sender", () => {
    const statement = upBody.slice(
      upBody.indexOf('UPDATE "messages" AS "message"'),
    );

    expect(statement).toContain('SET "sender_identity_id" = "identity"."id"');
    expect(statement).toContain('FROM "identities" AS "identity"');
    expect(statement).toContain('"identity"."user_id" = "message"."sender_id"');
    expect(statement).toContain(`"identity"."kind" = 'profile'`);
    // The message backfill joins straight to `identities` on the sender's
    // own `user_id`, with no join through `conversation_participants`.
    expect(statement).not.toContain('conversation_participants');
  });

  it('restricts both backfills to a profile identity, so a business or staff identity never seeds the join', () => {
    const backfillBlock = upBody.slice(
      upBody.indexOf('UPDATE "conversation_participants" AS "participant"'),
    );
    const profileKindMatches =
      backfillBlock.match(/"identity"\."kind" = 'profile'/g) ?? [];

    expect(profileKindMatches).toHaveLength(2);
  });

  it('drops the columns in the reverse order it added them', () => {
    const dropSenderIdentityIndex = downBody.indexOf(
      'ALTER TABLE "messages" DROP COLUMN "sender_identity_id"',
    );
    const dropIdentityIndex = downBody.indexOf(
      'ALTER TABLE "conversation_participants" DROP COLUMN "identity_id"',
    );

    expect(dropSenderIdentityIndex).toBeGreaterThanOrEqual(0);
    expect(dropIdentityIndex).toBeGreaterThan(dropSenderIdentityIndex);
  });

  it('carries the do-not-run banner', () => {
    expect(sql).toContain(
      '// DO NOT RUN: authored for review only; the maintainer runs migrations.',
    );
  });
});
