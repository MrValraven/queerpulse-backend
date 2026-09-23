import { DataSource } from 'typeorm';
import { OfficialConversationsService } from './official-conversations.service';

/**
 * F2 (C3, first half): the member's seat in their official thread is written
 * with raw SQL, and `conversation_participants.identity_id` is NOT NULL, so
 * the seat must carry the member's own profile identity. A member created
 * after the identities backfill who never messaged anyone has no profile
 * identity row yet, so the batch mints the missing ones before it seats.
 * The statements are captured from a mocked `manager.query`; the real-Postgres
 * run of the same method is recorded in the F2 report.
 */
describe('OfficialConversationsService.getOrCreateOfficialConversations', () => {
  const MEMBER_ID = '30000000-0000-4000-8000-000000000001';
  const OTHER_MEMBER_ID = '30000000-0000-4000-8000-000000000002';

  function build() {
    const statements: { sql: string; parameters: unknown[] }[] = [];
    const manager = {
      query: jest.fn((sql: string, parameters: unknown[]) => {
        statements.push({ sql, parameters });
        if (sql.trimStart().startsWith('SELECT')) {
          return Promise.resolve([
            { id: 'official-thread-1', official_member_id: MEMBER_ID },
            { id: 'official-thread-2', official_member_id: OTHER_MEMBER_ID },
          ]);
        }
        return Promise.resolve([]);
      }),
    };
    const dataSource = {
      transaction: jest.fn(
        (callback: (transactionManager: typeof manager) => Promise<unknown>) =>
          callback(manager),
      ),
    };
    const service = new OfficialConversationsService(
      dataSource as unknown as DataSource,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, statements };
  }

  const seatInsertOf = (statements: { sql: string }[]) =>
    statements.find((statement) =>
      statement.sql.includes('INSERT INTO "conversation_participants"'),
    );

  it('seats each member with their own profile identity', async () => {
    const { service, statements } = build();

    const threadByMember = await service.getOrCreateOfficialConversations([
      MEMBER_ID,
      OTHER_MEMBER_ID,
    ]);

    expect(threadByMember.get(MEMBER_ID)).toBe('official-thread-1');
    const seatInsert = seatInsertOf(statements);
    if (!seatInsert) {
      throw new Error('expected the member seat insert');
    }
    const compactSql = seatInsert.sql.replace(/\s+/g, ' ');
    expect(compactSql).toContain(
      '("conversation_id", "user_id", "identity_id")',
    );
    expect(compactSql).toContain(
      'JOIN "identities" profile_identity ON profile_identity.user_id = pair.user_id AND profile_identity.kind = \'profile\'',
    );
    expect(compactSql).toContain('profile_identity.id');
  });

  it('mints a missing profile identity for every member before seating them', async () => {
    const { service, statements } = build();

    await service.getOrCreateOfficialConversations([
      MEMBER_ID,
      OTHER_MEMBER_ID,
    ]);

    const mintIndex = statements.findIndex((statement) =>
      statement.sql.includes('INSERT INTO "identities"'),
    );
    const seatIndex = statements.findIndex((statement) =>
      statement.sql.includes('INSERT INTO "conversation_participants"'),
    );
    expect(mintIndex).toBeGreaterThan(-1);
    expect(mintIndex).toBeLessThan(seatIndex);
    const mint = statements[mintIndex];
    expect(mint?.sql.replace(/\s+/g, ' ')).toContain(
      'ON CONFLICT ("user_id") WHERE "user_id" IS NOT NULL DO NOTHING',
    );
    expect(mint?.parameters).toEqual([[MEMBER_ID, OTHER_MEMBER_ID]]);
  });
});
