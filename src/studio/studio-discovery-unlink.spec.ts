import { EntityManager } from 'typeorm';
import { forgetDiscoveryTiesOfPersona } from './studio-discovery-unlink';

describe('forgetDiscoveryTiesOfPersona', () => {
  const PERSONA_ID = 'fa000000-0000-4000-8000-000000000001';

  it('deletes every credit the persona gave or received, the picks of its releases and its spotlight places', async () => {
    const query = jest
      .fn<Promise<unknown>, [string, unknown[]?]>()
      .mockResolvedValue(undefined);

    await forgetDiscoveryTiesOfPersona(
      { query } as unknown as EntityManager,
      PERSONA_ID,
    );

    const [creditSql, creditParameters] = query.mock.calls[0] ?? [];
    expect(creditSql).toContain('DELETE FROM "studio_persona_credits"');
    expect(creditSql).toContain('"subprofile_id" = $1');
    expect(creditSql).toContain('"requested_by_subprofile_id" = $1');
    expect(creditSql).toContain('"release"."subprofile_id" = $1');
    expect(creditParameters).toEqual([PERSONA_ID]);
    const [pickSql, pickParameters] = query.mock.calls[1] ?? [];
    expect(pickSql).toContain('DELETE FROM "studio_curated_picks"');
    expect(pickParameters).toEqual([PERSONA_ID]);
    const [spotlightSql, spotlightParameters] = query.mock.calls[2] ?? [];
    expect(spotlightSql).toContain('DELETE FROM "studio_spotlight_artists"');
    expect(spotlightSql).toContain('"subprofile_id" = $1');
    expect(spotlightParameters).toEqual([PERSONA_ID]);
  });
});
