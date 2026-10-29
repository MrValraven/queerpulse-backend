import { EntityManager } from 'typeorm';
import { studioLandingMemoGeneration } from './studio-landing-memo';
import { forgetLandingTiesOfPersona } from './studio-landing-unlink';

describe('forgetLandingTiesOfPersona', () => {
  const PERSONA_ID = 'fa000000-0000-4000-8000-000000000003';

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

  it('deletes the card, the founding row and the main persona previews, then bumps the memo', async () => {
    const before = studioLandingMemoGeneration();

    await forgetLandingTiesOfPersona(manager, PERSONA_ID);

    expect(
      query.mock.calls.map(([sql, parameters]) => [
        tableDeletedBy(sql),
        parameters,
      ]),
    ).toEqual([
      ['studio_landing_artist_cards', [PERSONA_ID]],
      ['studio_founding_artists', [PERSONA_ID]],
      ['studio_landing_previews', [PERSONA_ID]],
    ]);
    expect(query.mock.calls.map(([sql]) => sql).join(' ')).toContain(
      '"release"."subprofile_id" = $1',
    );
    expect(studioLandingMemoGeneration()).toBe(before + 1);
  });

  it('finds the previews through the tracks of the persona releases only', async () => {
    await forgetLandingTiesOfPersona(manager, PERSONA_ID);

    const previewStatement = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('DELETE FROM "studio_landing_previews"'));
    expect(previewStatement).toContain('"track_id" IN (');
    expect(previewStatement).not.toContain('studio_track_credits');
  });
});
