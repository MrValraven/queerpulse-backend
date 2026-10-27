import { EntityManager } from 'typeorm';
import { forgetListeningOfPersona } from './studio-listening-unlink';

describe('forgetListeningOfPersona', () => {
  const PERSONA_ID = 'fa000000-0000-4000-8000-000000000002';

  let query: jest.Mock<Promise<unknown>, [string, unknown[]?]>;
  let manager: EntityManager;

  beforeEach(() => {
    query = jest
      .fn<Promise<unknown>, [string, unknown[]?]>()
      .mockResolvedValue(undefined);
    manager = { query } as unknown as EntityManager;
  });

  const tableDeletedBy = (sql: string) =>
    /DELETE FROM "([a-z_]+)"/.exec(sql)?.[1];

  it('deletes the daily totals and listens on the persona tracks and every supporter row naming it', async () => {
    await forgetListeningOfPersona(manager, PERSONA_ID);

    expect(
      query.mock.calls.map(([sql, parameters]) => [
        tableDeletedBy(sql),
        parameters,
      ]),
    ).toEqual([
      ['studio_track_play_daily', [PERSONA_ID]],
      ['studio_listens', [PERSONA_ID]],
      ['studio_supporters', [PERSONA_ID]],
    ]);
    expect(query.mock.calls.map(([sql]) => sql).join(' ')).toContain(
      '"shown_as_subprofile_id" = $1',
    );
  });

  it('finds the tracks through the releases of the persona', async () => {
    await forgetListeningOfPersona(manager, PERSONA_ID);

    const trackStatements = query.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => !sql.includes('studio_supporters'));
    expect(
      trackStatements.map((sql) =>
        sql.includes('"release"."subprofile_id" = $1'),
      ),
    ).toEqual([true, true]);
  });
});
