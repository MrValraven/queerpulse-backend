import { EntityManager } from 'typeorm';
import {
  carryIdentityBlocksToPersona,
  issueFreshPersonaId,
} from './subprofile-unlink-rekey';

/**
 * ENG-447: the statements that retire a persona's old id on unlink. The
 * primary-key update relies on the foreign keys cascading (migration
 * `1830060000000-CascadePersonaIdUpdates`); the rest move the references
 * that hold the id with no foreign key.
 */
describe('issueFreshPersonaId', () => {
  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const PREVIOUS_ID = '0b9f3c1e-5a52-4c51-9d6e-2f1a7c3b8e40';

  let query: jest.Mock<Promise<unknown>, [string, unknown[]?]>;
  let manager: EntityManager;

  beforeEach(() => {
    query = jest
      .fn<Promise<unknown>, [string, unknown[]?]>()
      .mockResolvedValue(undefined);
    manager = { query } as unknown as EntityManager;
  });

  const statementTouching = (table: string) =>
    query.mock.calls.find(([sql]) => sql.includes(`UPDATE "${table}"`));

  it('resolves with a new uuid and moves the persona row to it first', async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    expect(freshId).toMatch(UUID_PATTERN);
    expect(freshId).not.toBe(PREVIOUS_ID);
    expect(query.mock.calls[0]).toEqual([
      `UPDATE "subprofiles" SET "id" = $1 WHERE "id" = $2`,
      [freshId, PREVIOUS_ID],
    ]);
  });

  it('issues a different id on every call', async () => {
    const firstId = await issueFreshPersonaId(manager, PREVIOUS_ID);
    const secondId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    expect(firstId).not.toBe(secondId);
  });

  it('moves the item revision history to the new id', async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    expect(statementTouching('subprofile_item_revisions')?.[1]).toEqual([
      freshId,
      PREVIOUS_ID,
    ]);
  });

  // A takedown left on the old id would be lifted by the unlink.
  it('moves a moderator takedown to the new id', async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    const [sql, parameters] = statementTouching('content_moderation') ?? [];
    expect(sql).toContain('"subject_type" = $3 AND "subject_id" = $2');
    expect(parameters).toEqual([freshId, PREVIOUS_ID, 'subprofile']);
  });

  // A report filed before the id was canonicalised can spell it in capitals.
  it('moves the reports filed on the persona to the new id, matching the id case-blind', async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    const [sql, parameters] = statementTouching('reports') ?? [];
    expect(sql).toContain('"subject_type" = $3 AND lower("subject_id") = $2');
    expect(parameters).toEqual([freshId, PREVIOUS_ID, 'subprofile']);
  });

  // A legacy takedown under a capitalised id takes no effect today; the
  // unlink must not switch it on.
  it('moves only the takedown stored under the lowercase id', async () => {
    await issueFreshPersonaId(manager, PREVIOUS_ID);

    const [sql] = statementTouching('content_moderation') ?? [];
    expect(sql).not.toContain('lower(');
  });

  // Every public read lists the items by id, and shows each one's
  // `created_at` as its first-published date.
  it('gives every item of the persona a new id and restarts its created_at, right after the persona row moves', async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    expect(query.mock.calls[1]).toEqual([
      expect.stringContaining('UPDATE "subprofile_items"'),
      [freshId],
    ]);
    const [sql] = query.mock.calls[1] ?? [];
    expect(sql).toContain('SET "id" = gen_random_uuid(), "created_at" = now()');
    expect(sql).toContain('WHERE "subprofile_id" = $1');
  });

  // Only a current owner's own rows learn the new id.
  it('moves the id in notifications held by the persona owners alone', async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    const [sql, parameters] = statementTouching('notifications') ?? [];
    expect(sql).toContain(
      'SELECT "user_id" FROM "subprofile_members" WHERE "subprofile_id" = $3',
    );
    expect(parameters).toEqual([freshId, PREVIOUS_ID, freshId]);
  });

  it('stops at the first failing statement', async () => {
    query.mockRejectedValueOnce(new Error('foreign key violation'));

    await expect(issueFreshPersonaId(manager, PREVIOUS_ID)).rejects.toThrow(
      'foreign key violation',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  // Studio v1: the Studio pages, saved cards and stream routes address a
  // release and a track by id, so neither keeps the named persona's id.
  it('gives every Studio release a fresh id and moves its open reports with it', async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    const [sql, parameters] = statementTouching('studio_releases') ?? [];
    expect(sql).toContain('AS MATERIALIZED');
    expect(sql).toContain('gen_random_uuid() AS "fresh_id"');
    expect(sql).toContain(
      'UPDATE "reports" SET "subject_id" = "remapped"."fresh_id"::text',
    );
    expect(sql).toContain('"published_at" = CASE WHEN');
    expect(parameters).toEqual([freshId, 'studio_release']);
  });

  it('gives every Studio track a fresh id once its release has moved', async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    const releaseIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes('UPDATE "studio_releases"'),
    );
    const trackIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes('UPDATE "studio_tracks"'),
    );
    expect(trackIndex).toBeGreaterThan(releaseIndex);
    expect(query.mock.calls[trackIndex]?.[1]).toEqual([freshId]);
  });

  // Studio artist kinds: episode dates would match the named persona's
  // episodes, so they restart like the release dates.
  it('restarts the episode publish time in publish order and the alert claim in the track re-key', async () => {
    await issueFreshPersonaId(manager, PREVIOUS_ID);

    const [sql] = statementTouching('studio_tracks') ?? [];
    expect(sql).toContain(
      '"published_at" = CASE WHEN "studio_tracks"."published_at" IS NULL THEN NULL ELSE now() + make_interval(secs => "episode_order"."publish_rank" / 1000.0) END',
    );
    expect(sql).toContain(
      '"followers_notified_at" = CASE WHEN "studio_tracks"."followers_notified_at" IS NULL THEN NULL ELSE now() END',
    );
    expect(sql).toMatch(
      /FROM "studio_tracks" "ranked_track"\s+WHERE "ranked_track"\."release_id" IN \(/,
    );
  });

  // Studio v2: an unlink ends the named persona, so a playlist credited to it
  // turns private and loses the credit. The foreign key has already carried
  // the credit to the fresh id when this runs.
  it('releases the playlist credits once the persona row has moved', async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    const [sql, parameters] = statementTouching('studio_playlists') ?? [];
    expect(sql).toContain(`"visibility" = 'private'`);
    expect(sql).toContain(`"is_credited_to_persona" = false`);
    expect(parameters).toEqual([freshId]);
    const releaseIndex = query.mock.calls.findIndex(([statement]) =>
      statement.includes('UPDATE "studio_playlists"'),
    );
    expect(releaseIndex).toBeGreaterThan(0);
  });

  // Studio v3: nothing of the artist tools may tie the pseudonymous persona
  // to its named past.
  it('clears preview links and the track change stamp in the release re-key', async () => {
    await issueFreshPersonaId(manager, PREVIOUS_ID);

    const [sql] = statementTouching('studio_releases') ?? [];
    expect(sql).toContain('"preview_token" = NULL');
    expect(sql).toContain('"preview_link_created_at" = NULL');
    expect(sql).toContain('"tracks_changed_at" = NULL');
  });

  it('returns a scheduled release to draft and clears its drop time in the release re-key', async () => {
    await issueFreshPersonaId(manager, PREVIOUS_ID);

    const [sql = ''] = statementTouching('studio_releases') ?? [];
    expect(sql).toContain(
      `"status" = CASE WHEN "studio_releases"."status" = 'scheduled' THEN 'draft' ELSE "studio_releases"."status" END`,
    );
    expect(sql).toContain('"publish_at" = NULL');
    // A release date the schedule filled goes, as a takedown clears it; a
    // typed one stays.
    expect(sql).toMatch(
      /"released_on" = CASE\s+WHEN "studio_releases"\."status" = 'scheduled'\s+AND "studio_releases"\."released_on" = \("studio_releases"\."publish_at" AT TIME ZONE 'Europe\/Lisbon'\)::date\s+THEN NULL\s+ELSE "studio_releases"\."released_on"\s+END/,
    );
  });

  it('deletes the reminders of a scheduled release once it is back in draft', async () => {
    await issueFreshPersonaId(manager, PREVIOUS_ID);

    const releaseIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes('UPDATE "studio_releases"'),
    );
    const reminderIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes('DELETE FROM "studio_release_reminders"'),
    );
    expect(releaseIndex).toBeGreaterThan(-1);
    expect(reminderIndex).toBeGreaterThan(releaseIndex);
  });

  it('deletes the reminders members set on the named persona releases', async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    const reminderStatement = query.mock.calls.find(([sql]) =>
      sql.includes('DELETE FROM "studio_release_reminders"'),
    );
    expect(reminderStatement?.[1]).toEqual([freshId]);
  });

  it('restarts the version note dates and empties the press kit picks', async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    expect(statementTouching('studio_release_versions')?.[1]).toEqual([
      freshId,
    ]);
    const [pressKitSql, pressKitParameters] =
      statementTouching('studio_press_kits') ?? [];
    expect(pressKitSql).toContain(`"featured_track_ids" = '{}'`);
    expect(pressKitParameters).toEqual([freshId]);
  });

  it('gives every persona post a fresh id and clears its edit stamp', async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    const postStatement = query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE "subprofile_posts"'),
    );
    const [sql, parameters] = postStatement ?? [];
    expect(sql).toContain('AS MATERIALIZED');
    expect(sql).toContain('"edited_at" = NULL');
    expect(parameters).toEqual([freshId, 'persona_post']);
  });

  it('keeps the Updates order when it restarts the post dates', async () => {
    await issueFreshPersonaId(manager, PREVIOUS_ID);

    const postStatement = query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE "subprofile_posts"'),
    );
    const [sql] = postStatement ?? [];
    expect(sql).toContain(
      'row_number() OVER (ORDER BY "created_at" DESC, "id" DESC) AS "recency_rank"',
    );
    expect(sql).toContain(
      `"created_at" = now() - ("remapped"."recency_rank" * interval '1 millisecond')`,
    );
  });

  it('moves open reports on a persona post with it', async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    const postStatement = query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE "subprofile_posts"'),
    );
    const [sql, parameters] = postStatement ?? [];
    expect(sql).toContain(
      'UPDATE "reports" SET "subject_id" = "remapped"."fresh_id"::text',
    );
    expect(parameters).toEqual([freshId, 'persona_post']);
  });

  it('drops the post quota ledger of the named persona', async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    const ledgerStatement = query.mock.calls.find(([sql]) =>
      sql.includes('DELETE FROM "subprofile_post_quota_entries"'),
    );
    expect(ledgerStatement?.[1]).toEqual([freshId]);
  });

  it('runs the artist tools statements after the tracks move', async () => {
    await issueFreshPersonaId(manager, PREVIOUS_ID);

    const trackIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes('UPDATE "studio_tracks"'),
    );
    const postIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes('UPDATE "subprofile_posts"'),
    );
    expect(postIndex).toBeGreaterThan(trackIndex);
  });

  // Studio discovery: a credit or a staff pick kept across an unlink would
  // tie the pseudonymous persona to its named collaborators and shelf spot.
  it("forgets the persona's credits and staff picks before its releases get fresh ids", async () => {
    const freshId = await issueFreshPersonaId(manager, PREVIOUS_ID);

    const creditIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes('DELETE FROM "studio_persona_credits"'),
    );
    const pickIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes('DELETE FROM "studio_curated_picks"'),
    );
    const releaseIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes('UPDATE "studio_releases"'),
    );
    expect(creditIndex).toBeGreaterThan(0);
    expect(pickIndex).toBeGreaterThan(creditIndex);
    expect(releaseIndex).toBeGreaterThan(pickIndex);
    expect(query.mock.calls[creditIndex]?.[1]).toEqual([freshId]);
    expect(query.mock.calls[pickIndex]?.[1]).toEqual([freshId]);
  });
});

/**
 * ENG-447: the blocks members placed on the persona's identity outlive the
 * identity the unlink deletes, as carried blocks of the persona.
 */
describe('carryIdentityBlocksToPersona', () => {
  const PERSONA_ID = '7c1f0a52-1b0e-4c2a-9d1e-5f3b8a6c4d21';

  it('turns each block of the persona identity into a carried block of the persona', async () => {
    const query = jest
      .fn<Promise<unknown>, [string, unknown[]?]>()
      .mockResolvedValue(undefined);

    await carryIdentityBlocksToPersona(
      { query } as unknown as EntityManager,
      PERSONA_ID,
    );

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0] ?? [];
    expect(parameters).toEqual([PERSONA_ID]);
    expect(sql).toContain('UPDATE "identity_blocks"');
    expect(sql).toContain('"blocked_subprofile_id" = "persona"."id"');
    expect(sql).toContain(
      '"retired_identity_id" = "identity_blocks"."identity_id"',
    );
    expect(sql).toContain('"blocked_name_snapshot" = "persona"."display_name"');
    expect(sql).toContain('"identity_id" = NULL');
    expect(sql).toContain('"persona_identity"."subprofile_id" = $1');
    expect(sql).toContain(`"persona_identity"."kind" = 'subprofile'`);
  });
});
