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
